/**
 * Work one group company does for another, posted as the two facts it is.
 *
 * The shop is the case that made this necessary. When TruckMax repairs an
 * XTRACK truck and bills $1,000, the group has not spent $1,000 — it has
 * spent whatever the parts and labour cost. The $1,000 is a cost to the
 * carrier AND revenue to the shop, and on consolidation those cancel,
 * leaving the real cost behind.
 *
 * Posting only the carrier's side, which is what happened before this
 * existed, is wrong three ways at once:
 *
 *   - the shop's margin is invisible, so nobody can answer whether running
 *     a shop beats sending trucks out;
 *   - the group's cost is overstated by the shop's markup;
 *   - the shop has no revenue for work it really did, so it has no P&L.
 *
 * Both legs are written in one transaction and share an
 * `intercompany_pair_id`. A ledger cannot enforce "the other leg exists"
 * with a row constraint — that is a fact about two rows — so the pairing is
 * what makes it checkable, and `accounting.v_intercompany_unbalanced` is
 * where a missing or mismatched leg shows up.
 */
import { randomUUID } from 'node:crypto';

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

export class IntercompanyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntercompanyError';
  }
}

export interface ShopWorkInput {
  /** The company doing the work. Must be an entity of kind 'shop'. */
  shopEntityId: string;
  /** The company being billed. */
  billedEntityId: string;
  accrualDate: string;
  /** What the shop charged, as a positive decimal string. */
  amount: string;
  /** The billed company's cost category — e.g. `maintenance.repair`. */
  categoryId: string;
  truckId?: string | null;
  unitNumber?: string | null;
  memo?: string | null;
  /** The invoice. Either this or `assertedBasis` is required — see below. */
  sourceDocumentId?: string | null;
  /**
   * Why this is being posted without an invoice, in the words of the person
   * posting it. The ledger requires a manual entry to carry an attestation:
   * a figure nobody has put their name to is the kind this build refuses.
   * Shop work recorded before its paperwork arrives is legitimate; recording
   * it anonymously is not.
   */
  assertedBasis?: string | null;
  postedBy: string;
}

export interface ShopWorkResult {
  pairId: string;
  billedEntryId: string;
  shopEntryId: string;
}

const SHOP_REVENUE_CATEGORY = 'revenue.shop_work';

export async function postShopWork(q: QueryFn, input: ShopWorkInput): Promise<ShopWorkResult> {
  if (input.shopEntityId === input.billedEntityId) {
    throw new IntercompanyError('A company cannot bill itself. The shop and the billed company are the same entity.');
  }
  if (!/^\d+(\.\d+)?$/.test(input.amount) || Number(input.amount) <= 0) {
    throw new IntercompanyError(
      `Shop work must be billed as a positive amount; got "${input.amount}". ` +
        'The sign is decided here — a cost to one side, revenue to the other — not by the caller.',
    );
  }

  const kindRows = await q(`SELECT kind::text AS kind, code FROM accounting.entity WHERE entity_id = $1`, [
    input.shopEntityId,
  ]);
  const shop = kindRows[0] as { kind: string; code: string } | undefined;
  if (!shop) throw new IntercompanyError(`No entity ${input.shopEntityId}.`);
  if (shop.kind !== 'shop') {
    throw new IntercompanyError(
      `${shop.code} is a ${shop.kind}, not a shop, so it cannot bill shop work. ` +
        'If it should be a shop, set its kind — a carrier billing repair work to another carrier is a ' +
        'different transaction and needs its own treatment.',
    );
  }

  if (!input.sourceDocumentId && !input.assertedBasis) {
    throw new IntercompanyError(
      'Shop work needs either the invoice that bills it, or a stated basis for posting it without one. ' +
        'The ledger will not hold a manual figure nobody has put their name to.',
    );
  }

  const pairId = randomUUID();
  const billedEntryId = randomUUID();
  const shopEntryId = randomUUID();
  const sourceKind = input.sourceDocumentId ? 'document' : 'manual';

  // One attestation covers both legs: they are one assertion about one piece
  // of work, and two would imply somebody asserted them separately.
  let attestationId: string | null = null;
  if (sourceKind === 'manual') {
    const att = (await q(
      `INSERT INTO accounting.manual_attestation (asserted_by, basis) VALUES ($1, $2)
       RETURNING attestation_id`,
      [input.postedBy, input.assertedBasis],
    )) as { attestation_id: string }[];
    attestationId = att[0]!.attestation_id;
  }
  const magnitude = Number(input.amount).toFixed(4);
  const negative = `-${magnitude}`;

  const insert = async (
    entryId: string,
    entityId: string,
    counterpartyId: string,
    categoryId: string,
    amount: string,
    memo: string,
  ): Promise<void> => {
    await q(
      `INSERT INTO accounting.ledger_entry
         (entry_id, entity_id, counterparty_entity_id, intercompany_pair_id,
          truck_id, accrual_date, category_id, amount, unit_number,
          source_kind, source_document_id, attestation_id, memo, posted_by, allocation_basis)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9,
               $10::accounting.source_kind, $11, $12, $13, $14, 'actual')`,
      [
        entryId, entityId, counterpartyId, pairId,
        input.truckId ?? null, input.accrualDate, categoryId, amount, input.unitNumber ?? null,
        sourceKind, input.sourceDocumentId ?? null, attestationId, memo, input.postedBy,
      ],
    );
  };

  const note = input.memo ? `${input.memo} ` : '';
  await insert(
    billedEntryId, input.billedEntityId, input.shopEntityId, input.categoryId, negative,
    `${note}Billed by ${shop.code}.`,
  );
  await insert(
    shopEntryId, input.shopEntityId, input.billedEntityId, SHOP_REVENUE_CATEGORY, magnitude,
    `${note}Work billed to another group company.`,
  );

  return { pairId, billedEntryId, shopEntryId };
}

export interface UnbalancedPair {
  intercompanyPairId: string;
  legs: number;
  net: string;
  firstDate: string;
  problem: string;
}

/**
 * Intercompany transactions that do not balance. Empty is the only
 * acceptable state, which is what makes this worth showing rather than
 * merely computing.
 */
export async function unbalancedIntercompany(q: QueryFn): Promise<UnbalancedPair[]> {
  const rows = await q(
    // legs::int because count(*) is a bigint, and node-postgres hands a
    // bigint back as a STRING to avoid losing precision. Typed as a number
    // and left uncast, `legs === 1` is quietly false forever.
    `SELECT intercompany_pair_id::text AS "intercompanyPairId",
            legs::int                  AS "legs",
            net::text                  AS "net",
            first_date::text           AS "firstDate",
            problem
       FROM accounting.v_intercompany_unbalanced
      ORDER BY first_date`,
  );
  return rows as UnbalancedPair[];
}

/**
 * Shop work billed to someone outside the group — a driver, or an
 * individual owner.
 *
 * This is NOT an intercompany transaction and must not be posted as one.
 * Nobody inside the group bears the cost, so there is no second leg to
 * write; inventing one would put a cost on a company that was never billed.
 * TruckMax's revenue is real either way, which is the whole point: the shop
 * earns from outside customers too, and a shop P&L that counted only
 * group work would understate it.
 */
export interface ExternalShopWorkInput {
  shopEntityId: string;
  accrualDate: string;
  amount: string;
  truckId?: string | null;
  unitNumber?: string | null;
  memo?: string | null;
  sourceDocumentId?: string | null;
  assertedBasis?: string | null;
  postedBy: string;
}

export async function postExternalShopWork(q: QueryFn, input: ExternalShopWorkInput): Promise<string> {
  if (!/^\d+(\.\d+)?$/.test(input.amount) || Number(input.amount) <= 0) {
    throw new IntercompanyError(`Shop work must be billed as a positive amount; got "${input.amount}".`);
  }
  if (!input.sourceDocumentId && !input.assertedBasis) {
    throw new IntercompanyError(
      'Shop work needs either the invoice that bills it, or a stated basis for posting it without one.',
    );
  }
  const kindRows = await q(`SELECT kind::text AS kind, code FROM accounting.entity WHERE entity_id = $1`, [
    input.shopEntityId,
  ]);
  const shop = kindRows[0] as { kind: string; code: string } | undefined;
  if (!shop) throw new IntercompanyError(`No entity ${input.shopEntityId}.`);
  if (shop.kind !== 'shop') throw new IntercompanyError(`${shop.code} is a ${shop.kind}, not a shop.`);

  let attestationId: string | null = null;
  if (!input.sourceDocumentId) {
    const att = (await q(
      `INSERT INTO accounting.manual_attestation (asserted_by, basis) VALUES ($1, $2)
       RETURNING attestation_id`,
      [input.postedBy, input.assertedBasis],
    )) as { attestation_id: string }[];
    attestationId = att[0]!.attestation_id;
  }

  const entryId = randomUUID();
  await q(
    `INSERT INTO accounting.ledger_entry
       (entry_id, entity_id, truck_id, accrual_date, category_id, amount, unit_number,
        charged_to, source_kind, source_document_id, attestation_id, memo, posted_by, allocation_basis)
     VALUES ($1, $2, $3, $4::date, 'revenue.shop_work', $5, $6,
             'driver', $7::accounting.source_kind, $8, $9, $10, $11, 'actual')`,
    [
      entryId, input.shopEntityId, input.truckId ?? null, input.accrualDate,
      Number(input.amount).toFixed(4), input.unitNumber ?? null,
      input.sourceDocumentId ? 'document' : 'manual',
      input.sourceDocumentId ?? null, attestationId, input.memo ?? null, input.postedBy,
    ],
  );
  return entryId;
}


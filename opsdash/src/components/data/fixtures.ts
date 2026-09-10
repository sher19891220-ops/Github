/**
 * Seed data for the local mock API (`mockApi.ts`).
 *
 * These are hand-built fixtures shaped like the real documents described in
 * `docs/SOURCE-DISCOVERY.md` (§3 fuel purchase rows, §5 the expenses sheet's
 * `Issued To` / `Expense side` / date defects) — not synthetic numbers dressed
 * up as real ones, and never used anywhere near a test that asserts against
 * real historical totals. They exist only so this UI has something
 * contract-shaped to render before the API agent's routes land.
 */

import type { StagingRow } from '@/contract/types';
import type { CategoryOption, DocumentSummary, NamedOption } from './types';

export const ENTITIES: NamedOption[] = [
  { id: 'ent-zone', label: 'Zone OH LLC', isActive: true },
  { id: 'ent-xtrack', label: 'Xtrack LLC', isActive: true },
  { id: 'ent-afg', label: 'AFG', isActive: true },
];

export const TRUCKS: NamedOption[] = [
  { id: 'trk-50174', label: '50174', isActive: true },
  { id: 'trk-6169', label: '6169', isActive: true },
  { id: 'trk-15852', label: '15852', isActive: true },
  { id: 'trk-9859', label: '9859', isActive: true },
];

export const DRIVERS: NamedOption[] = [
  { id: 'drv-1', label: 'D. Alvarez (#496648)', isActive: true },
  { id: 'drv-2', label: 'M. Okafor (#6169)', isActive: true },
  { id: 'drv-3', label: 'R. Petrov', isActive: true },
];

export const CATEGORIES: CategoryOption[] = [
  { id: 'fuel.diesel', label: 'Fuel — diesel', categoryGroup: 'fuel', sign: -1, isActive: true },
  { id: 'toll.ezpass', label: 'Toll — EZPass', categoryGroup: 'toll', sign: -1, isActive: true },
  { id: 'toll.violation', label: 'Toll — violation', categoryGroup: 'toll', sign: -1, isActive: true },
  { id: 'maintenance.repair', label: 'Maintenance — repair', categoryGroup: 'maintenance', sign: -1, isActive: true },
  { id: 'maintenance.tires', label: 'Maintenance — tires', categoryGroup: 'maintenance', sign: -1, isActive: true },
  { id: 'revenue.linehaul', label: 'Revenue — linehaul', categoryGroup: 'revenue', sign: 1, isActive: true },
];

export interface DocumentFixture {
  summary: DocumentSummary;
  rows: StagingRow[];
}

export const DOCUMENTS: DocumentFixture[] = [
  {
    summary: {
      documentId: 'doc-fuel-0091',
      docType: 'fuel',
      fileName: 'EFS_statement_2026-01.csv',
      parseStatus: 'parsed',
      parseError: null,
      rowCount: 3,
      uploadedAt: '2026-09-08T14:02:00Z',
      sha256: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000aa',
      duplicateOf: null,
    },
    rows: [
      {
        stagingRowId: 'row-f-1',
        documentId: 'doc-fuel-0091',
        rowIndex: 1,
        sourcePage: 1,
        parsedPayload: {
          unit: '50174',
          driver: '496648 D ALVAREZ',
          location: '66377 Main St, Belmont, OH 43718, United States',
          gallon: 'full tank',
          price: '3.56$',
        },
        reviewedPayload: null,
        entityId: 'ent-zone',
        truckId: 'trk-50174',
        driverId: 'drv-1',
        accrualDate: '2026-01-06',
        categoryId: 'fuel.diesel',
        amount: '-693.44',
        quantity: null,
        jurisdiction: 'OH',
        status: 'parsed',
        reviewNotes: null,
      },
      {
        // Entity attribution gap: SOURCE-DISCOVERY §8 — 95% of dispatch
        // revenue has no explicit entity marker. This row models that same
        // defect landing in a document instead of the sheet.
        stagingRowId: 'row-f-2',
        documentId: 'doc-fuel-0091',
        rowIndex: 2,
        sourcePage: 1,
        parsedPayload: {
          unit: '6169',
          driver: 'M OKAFOR # 6169',
          location: '210 Route 9, Fishkill, NY 12524, United States',
          gallon: '80g',
          price: '3.49$',
        },
        reviewedPayload: null,
        entityId: null, // unresolved — see SOURCE-DISCOVERY §8; never guessed
        truckId: 'trk-6169',
        driverId: 'drv-2',
        accrualDate: '2026-01-06',
        categoryId: 'fuel.diesel',
        amount: '-279.20',
        quantity: '80.0000',
        jurisdiction: 'NY',
        status: 'parsed',
        reviewNotes: null,
      },
      {
        // Category never resolved by the parser (free-text noise near this
        // row per SOURCE-DISCOVERY §3) — blocked until a human picks one.
        stagingRowId: 'row-f-3',
        documentId: 'doc-fuel-0091',
        rowIndex: 3,
        sourcePage: 1,
        parsedPayload: {
          unit: '15852',
          driver: 'R PETROV',
          location: 'unreadable scan region',
          gallon: 'full tank',
          price: '3.61$',
        },
        reviewedPayload: null,
        entityId: 'ent-zone',
        truckId: 'trk-15852',
        driverId: 'drv-3',
        accrualDate: '2026-01-07',
        categoryId: null,
        amount: '-410.02',
        quantity: null,
        jurisdiction: null,
        status: 'parsed',
        reviewNotes: null,
      },
    ],
  },
  {
    summary: {
      documentId: 'doc-exp-0044',
      docType: 'maintenance',
      fileName: 'Truck_and_trailer_expenses_ZONE.xlsx',
      parseStatus: 'parsed',
      parseError: null,
      rowCount: 2,
      uploadedAt: '2026-09-07T09:15:00Z',
      sha256: 'b2c3d4e5f6000000000000000000000000000000000000000000000000bb',
      duplicateOf: null,
    },
    rows: [
      {
        stagingRowId: 'row-e-1',
        documentId: 'doc-exp-0044',
        rowIndex: 1,
        sourcePage: null,
        parsedPayload: {
          workOrder: 'EFS-7712',
          issuedTo: '496648 D ALVAREZ',
          unitType: 'trailer',
          costType: '2 tires replaced',
          dateRaw: '01.06.26',
          expenseSide: 'company',
        },
        reviewedPayload: null,
        entityId: 'ent-zone',
        truckId: null, // trailer cost — never forced onto a truck id
        driverId: 'drv-1',
        accrualDate: '2026-01-06',
        categoryId: 'maintenance.tires',
        amount: '-693.44',
        quantity: null,
        jurisdiction: null,
        status: 'parsed',
        reviewNotes: null,
      },
      {
        // Mistyped year, per SOURCE-DISCOVERY §5.1 ("01.06.25 in a run of
        // 01.06.26 rows") — surfaced for review rather than guessed.
        stagingRowId: 'row-e-2',
        documentId: 'doc-exp-0044',
        rowIndex: 2,
        sourcePage: null,
        parsedPayload: {
          workOrder: 'EFS-7713',
          issuedTo: 'M OKAFOR #6169',
          unitType: 'truck',
          costType: 'brake job',
          dateRaw: '01.06.25',
          expenseSide: 'driver',
        },
        reviewedPayload: null,
        entityId: 'ent-xtrack',
        truckId: 'trk-6169',
        driverId: 'drv-2',
        accrualDate: null, // the mistyped year is deliberately not guessed
        categoryId: 'maintenance.repair',
        amount: '-1245.00',
        quantity: null,
        jurisdiction: null,
        status: 'parsed',
        reviewNotes: 'Date printed as 01.06.25 — surrounding rows are 01.06.26. Confirm before setting the accrual date.',
      },
    ],
  },
  {
    summary: {
      documentId: 'doc-toll-0012',
      docType: 'toll',
      fileName: 'ezpass_statement_2026-08.pdf',
      parseStatus: 'failed',
      parseError:
        'Header checksum mismatch on page 2 (accounting.sheet_source rule): expected columns [Plate, Time, Plaza, Amount], found [Plate, Time, Amount]. Refusing to guess which column is money.',
      rowCount: 0,
      uploadedAt: '2026-09-06T11:40:00Z',
      sha256: 'c3d4e5f60000000000000000000000000000000000000000000000000cc',
      duplicateOf: null,
    },
    rows: [],
  },
];

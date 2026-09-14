# Fleet cost structure — full detail, per company and per unit

Generated from `analysis/build_cost_markdown.py`, itself reading only already-tested pipeline outputs (source fingerprint `8a112bd297831a47906e`). Multi-entity OTR dry van operation, Columbus OH: **Zone LLC (Zone-OH)**, **Xtrack LLC**, **AFG Transportco LLC**. Three separate operating companies sharing a common driver pool, equipment mix, and (for named US staff and the shop) group-level overhead.

## How to read this

- **Fixed cost** is charged whether or not the truck ran that week (rent, admin/insurance/trailer, fixed overhead, registration). It is priced **per company-driver truck** — owner-operators carry their own equipment and are not charged this way (see the Owner-operator section below).
- **Variable cost** is per loaded mile (fuel, driver pay, tolls, Iron Lease mileage charge, IFTA fuel tax, Oregon weight-mile tax where applicable).
- **Overhead** is a residual of each company's own P&L (`gross - net - company-driver block cost - owner-operator cost`), split fixed/variable on its own named components. It is **not** the same thing as the operator-supplied named-staff roster in the Group overhead roster section — a raise to a specific named person (e.g. an office manager or shop mechanic) moves the roster table, not this per-company residual.
- **Break-even** is the miles/truck-week a company-driver truck must run at its current rate/mile to cover its own fixed cost against its own contribution margin per mile — plus a table of break-even miles at a range of rates.
- **Insurance** here is the *effective* (at-cost) annual premium, priced per policy line: some lines are per scheduled unit, some are % of insured value, some are % of gross revenue, one is per mile. This is different from — and normally higher than — the sheet's blended 'admin/insurance/trailer' fixed-cost line shown separately above.
- **Per-unit table**: one row per truck number, aggregated across every week and every company that ran it in the P&L window (a truck can move between companies). `Avg RPM` is total gross ÷ total miles. Maintenance columns are a measured **floor** (combined Truck Max ledger + invoice log coverage is 42-44% of each company's own panel maintenance line — see the maintenance-ledger coverage figures above). Iron Lease tier is shown only for the ~22 trucks on that rate card; every other truck rents from elsewhere or the P&L's own measured rate.

## Per-company cost structure

### Zone LLC (Zone-OH)

Period: 2026-05-25..2026-08-17. Trucks: 35.1 total (29.8 company-driver, 5.3 owner-operator). Gross: $283,426/week. Net: $26,767/week.

**Fixed cost, per company-driver truck-week**

| Line | Amount |
|---|---:|
| Truck rent, base | $1,166 |
| Admin / insurance / trailer | $522 |
| Fixed company overhead | $672 |
| Subtotal, in the sheet | $2,360 |
| + IRP plates + HVUT (not in the sheet) | $31 |
| **TRUE fixed, per truck-week** | **$2,391** |
| per truck-day | $342 |

**Variable cost, per loaded mile**

| Line | Amount |
|---|---:|
| Fuel | $0.8163 |
| Driver pay | $0.8071 |
| Toll | $0.0834 |
| Iron Lease mileage charge | $0.0225 |
| + IFTA fuel tax (not in the sheet) | $0.0083 |
| + Oregon weight-mile tax (not in the sheet) | $0.0003 |
| **TRUE variable, per loaded mile** | **$1.7254** |

Overhead: $938/truck-week ($672 fixed + $266 variable), 3.29% of gross.

Current performance: 2,818 miles/truck-week at $2.928/mile.

**Break-even**

- Miles/truck-week needed at the current rate: **2,161**
- Rate/mile needed at current miles: **$2.641**
- Break-even miles/truck-week by rate:
  | Rate | Miles |
  |---:|---:|
  | $2.40 | 3,906 |
  | $2.60 | 2,959 |
  | $2.80 | 2,381 |
  | $3.00 | 1,993 |
  | $3.20 | 1,713 |

Idle truck cost: $1,879/week, $268/day.

**Insurance, annual (effective, at cost)**

| Line | Annual |
|---|---:|
| auto liability | $227,563 |
| physical damage power units | $189,107 |
| physical damage trailers ESTIMATED | $90,867 |
| occupational accident | $42,831 |
| motor truck cargo | $120,750 |
| excess motor truck cargo | $14,295 |
| **Total** | **$685,412** |

### Xtrack LLC

Period: 2026-06-01..2026-08-24. Trucks: 47.4 total (27.1 company-driver, 20.3 owner-operator). Gross: $386,295/week. Net: $23,525/week.

**Fixed cost, per company-driver truck-week**

| Line | Amount |
|---|---:|
| Truck rent, base | $1,165 |
| Admin / insurance / trailer | $459 |
| Fixed company overhead | $505 |
| Subtotal, in the sheet | $2,130 |
| + IRP plates + HVUT (not in the sheet) | $31 |
| **TRUE fixed, per truck-week** | **$2,160** |
| per truck-day | $309 |

**Variable cost, per loaded mile**

| Line | Amount |
|---|---:|
| Fuel | $0.8657 |
| Driver pay | $0.7922 |
| Toll | $0.0793 |
| Iron Lease mileage charge | $0.0115 |
| + IFTA fuel tax (not in the sheet) | $0.0070 |
| + Oregon weight-mile tax | — |
| **TRUE variable, per loaded mile** | **$1.7636** |

Overhead: $887/truck-week ($505 fixed + $382 variable), 4.69% of gross.

Current performance: 2,546 miles/truck-week at $2.968/mile.

**Break-even**

- Miles/truck-week needed at the current rate: **2,027**
- Rate/mile needed at current miles: **$2.721**
- Break-even miles/truck-week by rate:
  | Rate | Miles |
  |---:|---:|
  | $2.40 | 4,011 |
  | $2.60 | 2,951 |
  | $2.80 | 2,335 |
  | $3.00 | 1,931 |
  | $3.20 | 1,646 |

Idle truck cost: $1,532/week, $219/day.

**Insurance, annual (effective, at cost)**

| Line | Annual |
|---|---:|
| auto liability | $180,154 |
| physical damage power units | $150,325 |
| physical damage trailers ESTIMATED | $77,886 |
| occupational accident | $36,712 |
| motor truck cargo second layer | $40,540 |
| own package benchmark | $63,722 |
| **Total** | **$549,338** |

### AFG Transportco LLC

Period: 2026-06-01..2026-08-24. Trucks: 10.2 total (5.8 company-driver, 4.4 owner-operator). Gross: $104,579/week. Net: $13,291/week.

**Fixed cost, per company-driver truck-week**

| Line | Amount |
|---|---:|
| Truck rent, base | $1,167 |
| Admin / insurance / trailer | $451 |
| Fixed company overhead | $398 |
| Subtotal, in the sheet | $2,015 |
| + IRP plates + HVUT (not in the sheet) | $27 |
| **TRUE fixed, per truck-week** | **$2,043** |
| per truck-day | $292 |

**Variable cost, per loaded mile**

| Line | Amount |
|---|---:|
| Fuel | $0.8168 |
| Driver pay | $0.8628 |
| Toll | $0.0739 |
| Iron Lease mileage charge | $0.0330 |
| + IFTA fuel tax (not in the sheet) | $0.0020 |
| + Oregon weight-mile tax | — |
| **TRUE variable, per loaded mile** | **$1.7948** |

Overhead: $766/truck-week ($398 fixed + $368 variable), 3.60% of gross.

Current performance: 3,280 miles/truck-week at $3.122/mile.

**Break-even**

- Miles/truck-week needed at the current rate: **1,682**
- Rate/mile needed at current miles: **$2.497**
- Break-even miles/truck-week by rate:
  | Rate | Miles |
  |---:|---:|
  | $2.40 | 3,870 |
  | $2.60 | 2,824 |
  | $2.80 | 2,224 |
  | $3.00 | 1,834 |
  | $3.20 | 1,560 |

Idle truck cost: $1,549/week, $221/day.

**Insurance, annual (effective, at cost)**

| Line | Annual |
|---|---:|
| auto liability | $66,373 |
| physical damage power units | $51,318 |
| physical damage trailers ESTIMATED | $25,962 |
| occupational accident | $12,237 |
| **Total** | **$155,891** |

## Group overhead roster (operator-supplied, not per-company)

This is a *different* number from each company's own 'fixed company overhead' line above: it is the operator's own named US staff (1099) and shop labour roster, read from `config/overhead.json`, and it is **not** read by the per-company residual model at all. As of 2026-09-02, assuming 90 trucks:

| Line | Amount/week |
|---|---:|
| Tashkent office | $33,630 |
| US staff & office | $13,027 |
| Owners | $5,000 |
| Shop (excluded from the group default) | $10,265 |
| **Total, shop excluded (default)** | **$51,656** |
| **Total, shop included** | **$61,922** |

Group break-even, shop excluded: **1,112.20** $/truck-week, **1,252** miles/truck-week. Shop included: **1,226.25** $/truck-week, **1,380** miles/truck-week.

## Per-unit summary (every truck, aggregated across its full P&L window)

| Unit | Company(ies) | Weeks in P&L | Revenue weeks | Total gross | Total miles | Avg RPM | Maint. $/truck-week | Maint. $/mile | Iron Lease tier |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 495804 | AFG/ZONE | 28 | 28 | $371,621 | 132,487 | $2.805 | $72.25 | $0.0147 | — |
| 289906 | XTRACK | 27 | 27 | $321,010 | 105,087 | $3.055 | $39.03 | $0.0100 | — |
| 494652 | ZONE | 26 | 26 | $317,229 | 108,924 | $2.912 | $215.37 | $0.0514 | — |
| 560638 | XTRACK | 27 | 28 | $294,856 | 108,409 | $2.720 | $99.53 | $0.0248 | — |
| 519009 | XTRACK | 27 | 26 | $276,784 | 100,405 | $2.757 | $22.45 | $0.0060 | — |
| 495336 | ZONE | 26 | 26 | $274,632 | 97,985 | $2.803 | $25.89 | $0.0069 | — |
| 52602 | XTRACK | 26 | 23 | $274,506 | 77,734 | $3.531 | $0.00 | $0.0000 | — |
| 495803 | ZONE | 26 | 26 | $269,494 | 102,257 | $2.635 | $51.56 | $0.0131 | — |
| 496123 | XTRACK | 27 | 27 | $268,964 | 97,941 | $2.746 | $24.99 | $0.0069 | — |
| 494655 | ZONE | 26 | 25 | $263,060 | 103,492 | $2.542 | $40.39 | $0.0101 | — |
| 52613 | XTRACK | 27 | 25 | $261,605 | 75,180 | $3.480 | $61.10 | $0.0219 | — |
| 8482 | XTRACK | 27 | 25 | $260,922 | 90,734 | $2.876 | $34.04 | $0.0101 | — |
| 8092 | XTRACK/ZONE | 27 | 26 | $257,364 | 89,132 | $2.887 | $259.87 | $0.0758 | — |
| 8083 | AFG/ZONE | 28 | 27 | $253,437 | 88,286 | $2.871 | $200.90 | $0.0614 | — |
| 496166 | XTRACK/ZONE | 26 | 23 | $251,794 | 89,659 | $2.808 | $170.96 | $0.0496 | — |
| 494656 | XTRACK | 27 | 26 | $251,085 | 91,725 | $2.737 | $63.57 | $0.0187 | — |
| 560639 | ZONE | 26 | 26 | $250,094 | 94,696 | $2.641 | $25.00 | $0.0069 | — |
| 494653 | ZONE | 26 | 26 | $249,512 | 95,305 | $2.618 | $24.86 | $0.0068 | — |
| 495806 | XTRACK | 27 | 26 | $245,897 | 90,292 | $2.723 | $185.56 | $0.0555 | — |
| 8671 | XTRACK/ZONE | 27 | 25 | $243,077 | 80,367 | $3.025 | $0.00 | $0.0000 | — |
| 8133 | XTRACK | 27 | 25 | $241,999 | 88,068 | $2.748 | $310.98 | $0.0953 | — |
| 2639 | XTRACK | 26 | 27 | $240,985 | 71,375 | $3.376 | $76.01 | $0.0277 | — |
| 289912 | XTRACK | 27 | 26 | $239,787 | 87,735 | $2.733 | $53.19 | $0.0164 | — |
| 1431 | AFG/ZONE | 16 | 15 | $232,362 | 77,692 | $2.991 | $65.62 | $0.0135 | $900/wk + $0.12/mi |
| 15862 | XTRACK | 27 | 27 | $232,091 | 85,900 | $2.702 | $25.53 | $0.0080 | $735/wk + $0.10/mi |
| 6169 | XTRACK | 27 | 19 | $227,901 | 72,850 | $3.128 | $0.00 | $0.0000 | — |
| 496635 | AFG/XTRACK | 27 | 23 | $224,702 | 69,762 | $3.221 | $63.21 | $0.0245 | — |
| 4716 | AFG/ZONE | 16 | 15 | $223,525 | 70,720 | $3.161 | $139.62 | $0.0316 | $900/wk + $0.12/mi |
| 15739 | ZONE | 26 | 26 | $222,432 | 84,809 | $2.623 | $93.34 | $0.0286 | $735/wk + $0.10/mi |
| 484498 | ZONE | 26 | 23 | $221,909 | 88,337 | $2.512 | $60.77 | $0.0179 | — |
| 484515 | ZONE | 26 | 22 | $219,763 | 75,716 | $2.902 | $12.69 | $0.0044 | — |
| 289907 | ZONE | 26 | 23 | $218,844 | 80,315 | $2.725 | $67.81 | $0.0220 | — |
| 495808 | ZONE | 26 | 24 | $217,856 | 75,809 | $2.874 | $75.25 | $0.0258 | — |
| 495334 | ZONE | 26 | 23 | $217,833 | 79,249 | $2.749 | $54.22 | $0.0178 | — |
| 813 | AFG/XTRACK | 27 | 22 | $216,721 | 79,314 | $2.732 | — | — | — |
| 888 | XTRACK | 20 | 17 | $215,622 | 63,168 | $3.413 | $0.00 | $0.0000 | — |
| 496648 | ZONE | 26 | 21 | $211,418 | 80,175 | $2.637 | $16.46 | $0.0053 | — |
| 289905 | XTRACK | 27 | 24 | $211,209 | 75,919 | $2.782 | $78.95 | $0.0281 | — |
| 484506 | AFG/ZONE | 27 | 22 | $211,200 | 74,202 | $2.846 | $30.73 | $0.0112 | — |
| 7124 | XTRACK | 23 | 17 | $210,940 | 62,434 | $3.379 | $66.87 | $0.0246 | — |
| 496125 | XTRACK | 27 | 23 | $209,352 | 75,407 | $2.776 | $43.54 | $0.0156 | — |
| 1005 | XTRACK | 20 | 19 | $209,318 | 63,122 | $3.316 | $3.75 | $0.0012 | — |
| 12878 | XTRACK | 27 | 23 | $207,935 | 60,243 | $3.452 | $0.00 | $0.0000 | — |
| 8093 | XTRACK | 27 | 26 | $207,075 | 71,506 | $2.896 | $228.51 | $0.0863 | — |
| 289904 | AFG/XTRACK | 27 | 26 | $203,773 | 71,889 | $2.835 | $13.58 | $0.0051 | — |
| 7004 | XTRACK | 23 | 22 | $201,996 | 74,212 | $2.722 | $19.44 | $0.0060 | — |
| 7163 | XTRACK/ZONE | 25 | 24 | $201,644 | 70,160 | $2.874 | $27.42 | $0.0098 | — |
| 9859 | XTRACK | 27 | 22 | $197,224 | 72,062 | $2.737 | $30.93 | $0.0116 | $735/wk + $0.10/mi |
| 496163 | XTRACK/ZONE | 27 | 21 | $191,226 | 68,244 | $2.802 | $0.00 | $0.0000 | — |
| 8132 | XTRACK | 27 | 24 | $190,999 | 66,890 | $2.855 | $569.62 | $0.2299 | — |
| 289908 | AFG/XTRACK | 21 | 21 | $189,001 | 71,624 | $2.639 | $69.56 | $0.0262 | — |
| 8094 | XTRACK/ZONE | 27 | 23 | $187,933 | 74,820 | $2.512 | $227.92 | $0.0822 | — |
| 7126 | ZONE | 21 | 20 | $187,773 | 68,591 | $2.738 | $14.12 | $0.0043 | — |
| 15909 | XTRACK/ZONE | 26 | 20 | $187,466 | 64,301 | $2.915 | $29.42 | $0.0119 | $735/wk + $0.10/mi |
| 8033 | XTRACK | 24 | 24 | $187,151 | 64,763 | $2.890 | $87.32 | $0.0324 | — |
| 2743 | ZONE | 23 | 20 | $186,423 | 57,196 | $3.259 | $0.00 | $0.0000 | — |
| 4772 | ZONE | 23 | 20 | $184,226 | 65,841 | $2.798 | $71.30 | $0.0249 | $735/wk + $0.10/mi |
| 8131 | XTRACK/ZONE | 27 | 21 | $183,174 | 64,755 | $2.829 | $626.48 | $0.2612 | — |
| 594127 | ZONE | 18 | 18 | $182,094 | 61,239 | $2.973 | $31.12 | $0.0091 | — |
| 1509 | AFG/XTRACK/ZONE | 27 | 22 | $175,097 | 56,452 | $3.102 | $0.00 | $0.0000 | — |
| 289903 | XTRACK/ZONE | 27 | 20 | $173,629 | 67,107 | $2.587 | $50.45 | $0.0203 | — |
| 4857 | AFG/XTRACK | 14 | 13 | $156,416 | 42,850 | $3.650 | $0.00 | $0.0000 | — |
| 15852 | ZONE | 26 | 19 | $151,769 | 57,703 | $2.630 | $505.01 | $0.2275 | $735/wk + $0.10/mi |
| 6799 | AFG/XTRACK | 27 | 20 | $150,682 | 54,487 | $2.765 | $106.11 | $0.0526 | $735/wk + $0.10/mi |
| 484507 | ZONE | 26 | 16 | $147,398 | 56,942 | $2.589 | $44.58 | $0.0204 | — |
| 484505 | ZONE | 26 | 17 | $144,489 | 55,271 | $2.614 | $65.75 | $0.0309 | — |
| 484514 | XTRACK/ZONE | 25 | 15 | $144,145 | 50,239 | $2.869 | $88.03 | $0.0456 | — |
| 1662 | XTRACK | 17 | 16 | $142,868 | 49,137 | $2.908 | $22.23 | $0.0077 | — |
| 7605 | XTRACK/ZONE | 26 | 14 | $140,620 | 46,629 | $3.016 | $33.34 | $0.0186 | $900/wk + $0.12/mi |
| 1365 | AFG/XTRACK | 13 | 13 | $137,525 | 31,044 | $4.430 | $217.43 | $0.0840 | — |
| 289909 | XTRACK | 27 | 17 | $137,265 | 52,986 | $2.591 | $207.64 | $0.1058 | — |
| 4718 | XTRACK | 11 | 10 | $127,295 | 36,993 | $3.441 | $0.00 | $0.0000 | — |
| 5091 | ZONE | 15 | 11 | $126,818 | 42,034 | $3.017 | $0.00 | $0.0000 | — |
| 1722 | AFG/XTRACK | 14 | 12 | $126,299 | 39,942 | $3.162 | $26.51 | $0.0086 | $900/wk + $0.12/mi |
| 1564 | XTRACK | 12 | 10 | $124,577 | 37,960 | $3.282 | $0.00 | $0.0000 | — |
| 15 | AFG/XTRACK | 15 | 15 | $124,571 | 40,092 | $3.107 | — | — | — |
| 1489 | ZONE | 11 | 11 | $122,023 | 45,500 | $2.682 | $0.00 | $0.0000 | $900/wk + $0.12/mi |
| 484499 | ZONE | 26 | 16 | $117,016 | 45,313 | $2.582 | $6.53 | $0.0037 | — |
| 449248 | ZONE | 7 | 7 | $113,420 | 36,590 | $3.100 | $21.46 | $0.0041 | — |
| 1645 | XTRACK | 10 | 9 | $111,310 | 35,758 | $3.113 | $94.87 | $0.0265 | $900/wk + $0.12/mi |
| 1596 | AFG/XTRACK | 14 | 12 | $99,357 | 34,714 | $2.862 | $502.34 | $0.1881 | — |
| 5357 | XTRACK | 11 | 9 | $91,165 | 23,782 | $3.833 | — | — | — |
| 497377 | ZONE | 9 | 8 | $83,025 | 29,457 | $2.818 | $33.14 | $0.0101 | — |
| 1682 | XTRACK | 11 | 11 | $79,949 | 23,304 | $3.431 | $0.00 | $0.0000 | — |
| 4727 | XTRACK | 14 | 8 | $73,517 | 23,799 | $3.089 | $104.57 | $0.0615 | — |
| 8136 | ZONE | 26 | 7 | $71,780 | 30,542 | $2.350 | $7.54 | $0.0064 | — |
| 8091 | XTRACK | 27 | 9 | $70,735 | 24,483 | $2.889 | $75.61 | $0.0834 | — |
| 767492 | XTRACK | 11 | 8 | $70,507 | 24,912 | $2.830 | $105.97 | $0.0468 | — |
| 1568 | ZONE | 6 | 6 | $58,420 | 21,204 | $2.755 | $0.00 | $0.0000 | $900/wk + $0.12/mi |
| 2468 | ZONE | 9 | 7 | $57,750 | 20,366 | $2.836 | $0.00 | $0.0000 | — |
| 5426 | XTRACK | 6 | 5 | $56,306 | 15,041 | $3.744 | — | — | — |
| 487907 | ZONE | 5 | 5 | $51,800 | 16,635 | $3.114 | $0.00 | $0.0000 | — |
| 1 | ZONE | 10 | 7 | $50,061 | 20,670 | $2.422 | $0.00 | $0.0000 | — |
| 1984 | XTRACK | 4 | 4 | $43,470 | 12,177 | $3.570 | $0.00 | $0.0000 | — |
| 1471 | XTRACK | 4 | 4 | $32,970 | 10,599 | $3.111 | $18.66 | $0.0070 | — |
| 1699 | XTRACK | 4 | 3 | $29,970 | 9,075 | $3.302 | $0.00 | $0.0000 | — |
| 3773 | AFG | 3 | 3 | $25,671 | 7,632 | $3.364 | $0.00 | $0.0000 | $900/wk + $0.12/mi |
| 4709 | XTRACK | 3 | 3 | $22,795 | 6,809 | $3.348 | $0.00 | $0.0000 | — |
| 4937 | XTRACK | 3 | 3 | $21,950 | 7,037 | $3.119 | $0.00 | $0.0000 | — |
| 1542 | ZONE | 3 | 3 | $20,500 | 6,245 | $3.283 | $29.31 | $0.0141 | $900/wk + $0.12/mi |
| 7048 | ZONE | 7 | 2 | $18,875 | 7,444 | $2.536 | $18.42 | $0.0173 | — |
| 4836 | AFG | 2 | 2 | $18,600 | 5,483 | $3.392 | $0.00 | $0.0000 | — |
| 4864 | ZONE | 15 | 2 | $18,199 | 5,954 | $3.057 | $0.00 | $0.0000 | — |
| 5269 | ZONE | 2 | 2 | $12,480 | 4,100 | $3.044 | $0.00 | $0.0000 | $900/wk + $0.12/mi |
| 77485 | XTRACK | 2 | 2 | $11,900 | 3,229 | $3.685 | $0.00 | $0.0000 | — |
| 4553 | AFG | 1 | 1 | $8,100 | 2,337 | $3.466 | $0.00 | $0.0000 | — |
| 4549 | AFG | 1 | 1 | $7,146 | 2,009 | $3.557 | $0.00 | $0.0000 | $900/wk + $0.12/mi |
| 5026 | XTRACK | 1 | 1 | $2,700 | 850 | $3.176 | $0.00 | $0.0000 | — |
| 221202 | AFG | 1 | 0 | $0 | 900 | $0.000 | $0.00 | $0.0000 | — |
| 7 | AFG/ZONE | 2 | 0 | $0 | 1,200 | $0.000 | — | — | — |
| 7039 | ZONE | 1 | 0 | $0 | 1,650 | $0.000 | $0.00 | $0.0000 | — |
| LO | AFG | 1 | 0 | $0 | 1,600 | $0.000 | — | — | — |

## Sourcing and caveats

- All company-level figures above are read from `data/processed/facts.json` / `cost_breakdown_view.json` / `overhead_view.json` — built by `analysis/cost_structure.py`, `analysis/truck_breakeven.py`, `analysis/insurance_cost.py` and `analysis/breakeven.py`. Nothing in this document is recomputed independently of those modules' own test suites.
- Maintenance cost per truck is a **floor**, not the true cost: it covers only what two ledgers (the original Truck Max repair ledger and its separate invoice log) capture, cross-checked at 42-44% coverage of each company's own panel maintenance line.
- Registration (IRP/HVUT) has no column anywhere in the weekly P&L; it is priced separately from state filings and folded into 'fixed cost' above as a corrected, responsibility-adjusted rate.
- Owner-operator trucks are NOT priced the same way as company-driver trucks: they carry their own equipment and fuel, and the company's profit on one is only the company charge plus the fuel discount margin, not the block's gross.

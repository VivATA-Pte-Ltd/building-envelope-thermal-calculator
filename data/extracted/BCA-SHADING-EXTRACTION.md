# BCA external-shading extraction (verified from bundled official PDF)

## Source

- PDF: `../latest-source.pdf`
- Cover title: **CODE ON ENVELOPE THERMAL PERFORMANCE FOR BUILDINGS**
- PDF metadata title: `Microsoft Word - Envelope Code - Jan 2008 R3b.doc`
- PDF metadata creation date: 29 February 2008
- SHA-256: `fefc5a6e197022801aa47803789b9b486b4fbe50b3e0ce86be01e6c1de12776c`
- Page references below are the PDF page numbers / printed footer numbers. The contents pages are one page lower for Appendix B2.2 and Tables C12-C23, so the table of contents should not be used as the extraction page index.

## Machine-readable table structure

The normalized data are in `bca-shading-tables-C12-C23.csv`. Every SC is retained as the source's four-decimal string.

| Tables | Device | Orientation | Source pages | Inputs and grid | SC values/table |
|---|---|---|---:|---|---:|
| C12 | horizontal projection | North & South | 42 | R1=0.1…3.0 by 0.1; phi1=0°,10°,…50° | 180 |
| C13 | horizontal projection | East & West | 43 | same | 180 |
| C14 | horizontal projection | North-East & North-West | 44 | same | 180 |
| C15 | horizontal projection | South-East & South-West | 45 | same | 180 |
| C16 | vertical projection | North & South | 46 | R2=0.1…3.0 by 0.1; phi2=0°,10°,…50° | 180 |
| C17 | vertical projection | East & West | 47 | same | 180 |
| C18 | vertical projection | North-East & North-West | 48 | same | 180 |
| C19 | vertical projection | South-East & South-West | 49 | same | 180 |
| C20 | egg-crate | North & South | 50–52 | R1,R2=0.2…1.8 by 0.2; phi1=0°,10°,…40° | 405 |
| C21 | egg-crate | East & West | 53–55 | same | 405 |
| C22 | egg-crate | North-East & North-West | 56–58 | same | 405 |
| C23 | egg-crate | South-East & South-West | 59–61 | same | 405 |

Total normalized records: **3,060**. CSV columns are `table, device, orientation, R1, R2, inclination_deg, effective_SC, source_pdf_page`.

## Appendix B method (exact computational meaning)

### B2.2.1 — instantaneous heat gain (page 22)

The standard assumes the exposed portion receives total radiation and the shaded portion only diffuse radiation:

- `Q = Ae × IT + As × Id`
- `Q = Ae × ID + (Ae + As) × Id`
- `A = Ae + As`
- therefore `Q = Ae × ID + A × Id`
- hourly `SC = (Ae × ID + A × Id) / (A × IT) = (G × ID + Id) / IT`
- `G = Ae / A`, the fraction of window area exposed to direct solar radiation.

Symbols (page 22): `Q` solar heat gain; `Ae` exposed window area; `As` shaded window area; `IT` total radiation; `ID` direct radiation; `Id` diffused radiation.

### B2.2.2–B2.2.6 — daily/effective SC (page 23)

For 12 daylight hours:

`SC_day = [sum(h=1..12) (Ae × ID + A × Id)_h] / [sum(h=1..12) (A × IT)_h]`

The effective calculation uses representative days March 21, June 22, September 23 and December 22. March and September solar data are treated as almost identical, so the standard says March heat gain may be computed and doubled. The implementable form, confirmed by Example B3.1 on page 28, is:

`SC_effective = [2 sum_M(G ID + Id) + sum_J(G ID + Id) + sum_D(G ID + Id)] / [2 sum_M(IT) + sum_J(IT) + sum_D(IT)]`

Equivalently retain explicit M/J/S/D sums as shown on page 23, with S represented by the duplicated M term. Solar inputs come from Tables C8-C11 (pages 38-41).

### B2.3 geometry and G factor (pages 23–26)

Conventions (page 24):

- `theta1 = VSA`, always positive.
- `theta2 = HSA`; positive to the right of wall orientation, negative to the left.
- `phi1` = inclination of a horizontal projection relative to the horizontal plane; assumed positive for practical reasons.
- `phi2` = inclination of a vertical fin relative to wall orientation; positive to the right, negative to the left.

Horizontal projection fixed at window head (page 25):

- `As = P cos(phi1) tan(theta1) + P sin(phi1)`
- `G1 = 1 - R1 [cos(phi1) tan(theta1) + sin(phi1)]`
- `G1 = Ae/A`; `R1 = P/A` in the derivation, where `A` is the window height in the section diagram.
- Key B4.1 (page 31) denotes the same window height as `H`, hence table input `R1 = P/H`.
- Enforce `G1 >= 0`.

Continuous vertical fins in an array (pages 25–26):

- `As = |P cos(phi2) tan(theta2) - P sin(phi2)|`
- `G2 = 1 - R2 |cos(phi2) tan(theta2) - sin(phi2)|`
- `G2 = Ae/A`; `R2 = P/A` in the plan derivation, where `A` is fin spacing/window module width.
- Key B4.2 (page 31) calls that spacing `W`, hence table input `R2 = P/W`.
- Enforce `G2 >= 0`.
- For Tables C16-C19, page 26 says phi2 is selected from its positive/negative possibilities for the situation giving the lower SC; the tabulated angle grid is `|phi2| = 0°…50°`.

Egg-crate / combination fins (page 26):

- `G1 = 1 - R1 [cos(phi1) tan(theta1) - sin(phi1)]`
- `G2 = 1 - R2 |tan(theta2)|`
- `G3 = G1 × G2`
- Enforce `G3 >= 0`.
- Key B4.3 (page 31): `R1=P/H`, `R2=P/W`; the diagram uses the same projection depth `P` for horizontal and vertical components. Tables C20-C23 cover phi1=0°…40°.

## Verification

- PyMuPDF detected one ruled table per physical table page and equal-length columns on every page.
- Structural checks passed: C12-C19 each have 30 ratio rows × 6 angles; C20-C23 each have 9 × 9 ratio pairs × 5 angles.
- B5.1 on page 32 independently checks C15: R1=0.5, phi1=0° gives 0.6981 (reported rounded as 0.698); R1=0.4, phi1=30° gives 0.6692 (reported rounded as 0.669).
- First/last anchors: C12 (R1=0.1, 0°)=0.9380 on page 42; C23 (R1=1.8, R2=1.8, 40°)=0.4429 on page 61.

## Source limitations / cautions

1. The source table of contents is off by one page for this material; use the page fields in the CSV.
2. Page 23's displayed M/J/S/D numerator appears to omit a printed `+` between the J and S terms. The surrounding prose and worked Example B3.1 (page 28) remove the ambiguity: use `2M + J + D` in numerator and denominator.
3. Page 25 contains a dimensional typesetting error in an intermediate line (`Ae/As = A - As`); the preceding/following lines, the diagram and the definition establish `Ae = A - As` and `Ae/A = 1 - ...`.
4. The egg-crate horizontal `G1` expression on page 26 has **minus** `sin(phi1)`, unlike the simple head overhang's **plus** term on page 25. This is transcribed as printed and must not be silently unified.
5. The standard supplies discrete tabular grids. B5.2 (page 32) explicitly demonstrates interpolation in Table C13, but no extrapolation rule for ratios or inclinations beyond the table bounds is stated in Appendix B. Avoid extrapolation unless another governing provision authorizes it.
6. Tables are grouped into paired cardinal orientations; the PDF does not provide arbitrary-azimuth table values. First-principles calculation requires the hourly solar data in C8-C11 and the solar geometry in B1/B2.3.

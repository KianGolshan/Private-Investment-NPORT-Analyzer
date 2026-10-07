// Re-derives instrument_type for stored OTHER rows with today's
// classifyInstrument (via classifyStored), so a rule change reaches rows
// loaded before it (trap 45: loans filed as OTHER are debt). Idempotent: a
// run with nothing to change writes nothing. Each moved row also moves its
// filing's totals between "debt" and v1's Level-3 equity figure, exactly as
// filing-totals.addRow would have counted it (a stored row is a filing row).
const { classifyStored } = require('./keep-rule');

function reclassifyStored(db) {
  const rows = db
    .prepare(
      `SELECT accession, row_key, title, issuer_name, unit, asset_cat, other_asset, deriv_cat, instrument_type,
         balance, value_usd, fv_level
       FROM holdings WHERE asset_cat = 'OTHER' ORDER BY accession, row_key`
    )
    .all();
  const setType = db.prepare('UPDATE holdings SET instrument_type = ? WHERE accession = ? AND row_key = ?');
  const moveTotals = db.prepare(
    `UPDATE filing_totals SET rows_debt = rows_debt + @d, value_debt = value_debt + @d * @v,
       rows_l3_equity = rows_l3_equity - @l3, value_l3_equity = value_l3_equity - @l3 * @v
     WHERE accession = @accession`
  );
  const stats = { checked: rows.length, toDebt: 0, fromDebt: 0, other: 0, valueToDebt: 0 };
  db.transaction(() => {
    for (const r of rows) {
      const pricePerUnit = r.balance > 0 ? r.value_usd / r.balance : null;
      const type = classifyStored(
        {
          title: r.title,
          name: r.issuer_name,
          unit: r.unit,
          assetCat: r.asset_cat,
          otherAsset: r.other_asset,
          derivCat: r.deriv_cat,
        },
        pricePerUnit
      ).instrumentType;
      if (type === r.instrument_type) continue;
      setType.run(type, r.accession, r.row_key);
      const d = (type === 'debt') - (r.instrument_type === 'debt'); // +1 into debt, -1 out of it
      if (d) {
        const l3 = String(r.fv_level ?? '').trim() === '3' ? d : 0;
        moveTotals.run({ accession: r.accession, d, l3, v: r.value_usd || 0 });
      }
      if (d > 0) {
        stats.toDebt++;
        stats.valueToDebt += r.value_usd || 0;
      } else if (d < 0) stats.fromDebt++;
      else stats.other++;
    }
  })();
  return stats;
}

module.exports = { reclassifyStored };

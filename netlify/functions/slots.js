// GET /.netlify/functions/slots?date=YYYY-MM-DD  ->  { slots: [{ time:"18:00", free:true }, ...] }
const g = require('../lib/google');

exports.handler = async (event) => {
  try {
    const date = event.queryStringParameters?.date;
    const err = g.validateDate(date);
    if (err) return g.json(400, { error: err });

    const token = await g.getAccessToken();
    const busy = await g.getBusy(token, date);
    const slots = g.allSlots().map((time) => ({ time, free: g.isFree(busy, date, time) }));
    return g.json(200, { slots });
  } catch (e) {
    console.error(e);
    return g.json(500, { error: e.message });
  }
};

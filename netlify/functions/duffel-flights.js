const DUFFEL_KEY = process.env.DUFFEL_API_KEY;

// Real Duffel offer_requests shape, confirmed from their own docs — a slice
// per leg of the journey (origin, destination, date), passengers as an
// array. Sandbox tokens (duffel_test_...) hit their test airline, Duffel
// Airways, with zero real cost or risk.
async function queryDuffelFlights(origin, destination, departureDate, passengerCount){
  try{
    const passengers = Array.from({ length: passengerCount || 1 }, () => ({ type: 'adult' }));
    const res = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DUFFEL_KEY}`,
        'Duffel-Version': 'v2',
      },
      body: JSON.stringify({
        data: {
          slices: [{ origin, destination, departure_date: departureDate }],
          passengers,
        },
      }),
    });
    if(!res.ok){
      const errBody = await res.text().catch(() => '');
      throw new Error(`Duffel request failed: ${res.status} ${errBody}`);
    }
    const data = await res.json();
    const offers = (data.data && data.data.offers) || [];
    return offers.slice(0, 5).map(o => ({
      price: o.total_amount,
      currency: o.total_currency,
      airline: o.slices[0] && o.slices[0].segments[0] && o.slices[0].segments[0].operating_carrier
        ? o.slices[0].segments[0].operating_carrier.name : 'Unknown airline',
      departsAt: o.slices[0] && o.slices[0].segments[0] ? o.slices[0].segments[0].departing_at : null,
      arrivesAt: o.slices[0] && o.slices[0].segments[o.slices[0].segments.length - 1]
        ? o.slices[0].segments[o.slices[0].segments.length - 1].arriving_at : null,
      expiresAt: o.expires_at,
    }));
  } catch(err){
    console.error('queryDuffelFlights error:', err);
    return { error: err.message };
  }
}

module.exports = { queryDuffelFlights };

import { Router } from 'express';
import { requireDeviceId } from '../middleware/deviceId';

const router = Router();

const SKYSCANNER_BASE = "https://partners.api.skyscanner.net/apiservices/v3/flights/live/search";

function getNextWeekendDate(): { year: number; month: number; day: number } {
  const now = new Date();
  const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
  const friday = new Date(now);
  friday.setDate(now.getDate() + daysUntilFriday);
  return { year: friday.getFullYear(), month: friday.getMonth() + 1, day: friday.getDate() };
}

function buildSkyscannerQuery(homeAirport: string, destAirport: string, currency: string = "EUR") {
  return {
    query: {
      market: "ES",
      locale: "en-GB",
      currency,
      queryLegs: [
        {
          originPlaceId: { iata: homeAirport },
          destinationPlaceId: { iata: destAirport },
          date: getNextWeekendDate(),
        },
      ],
      adults: 1,
      cabinClass: "CABIN_CLASS_ECONOMY",
    },
  };
}

function getItineraryPrice(itin: any): number {
  const raw = parseFloat(itin.pricingOptions?.[0]?.price?.amount ?? "Infinity");
  return raw > 1000 ? raw / 1000 : raw;
}

function getItineraryDuration(itin: any, legs: any): number {
  const legId = itin.legIds?.[0];
  if (!legId || !legs?.[legId]) return Infinity;
  return legs[legId].durationInMinutes ?? Infinity;
}

function parseSkyscannerResult(data: any, origin: string, dest: string, currency: string): any {
  const itineraries = data?.content?.results?.itineraries;
  if (!itineraries) return null;

  const legs = data?.content?.results?.legs;
  const carriers = data?.content?.results?.carriers;
  const entries = Object.values(itineraries) as any[];
  if (entries.length === 0) return null;

  const minPrice = Math.min(...entries.map((e) => getItineraryPrice(e)));
  const maxPrice = Math.max(...entries.map((e) => getItineraryPrice(e)));
  const minDur = Math.min(...entries.map((e) => getItineraryDuration(e, legs)));
  const maxDur = Math.max(...entries.map((e) => getItineraryDuration(e, legs)));
  const priceRange = maxPrice - minPrice || 1;
  const durRange = maxDur - minDur || 1;

  entries.sort((a: any, b: any) => {
    const sA = (getItineraryPrice(a) - minPrice) / priceRange + (getItineraryDuration(a, legs) - minDur) / durRange;
    const sB = (getItineraryPrice(b) - minPrice) / priceRange + (getItineraryDuration(b, legs) - minDur) / durRange;
    return sA - sB;
  });

  const best = entries[0];
  const pricing = best.pricingOptions?.[0];
  if (!pricing) return null;

  const price = Math.round(getItineraryPrice(best));
  const durationMinutes = getItineraryDuration(best, legs);

  let airlineName = "Unknown";
  const legId = best.legIds?.[0];
  if (legId && legs && carriers) {
    const leg = legs[legId];
    const carrierId = leg?.operatingCarrierIds?.[0] ?? leg?.marketingCarrierIds?.[0];
    if (carrierId) airlineName = carriers[carrierId]?.name ?? "Unknown";
  }

  const date = getNextWeekendDate();
  const dateStr = `${date.year}${String(date.month).padStart(2, "0")}${String(date.day).padStart(2, "0")}`;
  const fallbackLink = `https://www.skyscanner.net/transport/flights/${origin.toLowerCase()}/${dest.toLowerCase()}/${dateStr}/`;

  return {
    price,
    currency,
    airline: airlineName,
    durationMinutes: durationMinutes === Infinity ? 0 : Math.round(durationMinutes),
    deeplink: pricing.items?.[0]?.deepLink || fallbackLink,
  };
}

router.post('/', requireDeviceId, async (req, res) => {
  const { iataCode, currency, homeAirport, maxPolls = 5 } = req.body;
  const apiKey = process.env.SKYSCANNER_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Missing SKYSCANNER_API_KEY in backend" });
  }

  try {
    const createRes = await fetch(`${SKYSCANNER_BASE}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(buildSkyscannerQuery(homeAirport, iataCode, currency)),
    });

    if (!createRes.ok) {
      return res.status(createRes.status).json({ error: await createRes.text() });
    }

    let data = await createRes.json();
    const sessionToken = data.sessionToken;
    let polls = 0;

    while (data.status === "RESULT_STATUS_INCOMPLETE" && polls < maxPolls && sessionToken) {
      await new Promise((r) => setTimeout(r, 2000));
      polls++;
      const pollRes = await fetch(`${SKYSCANNER_BASE}/poll/${sessionToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(buildSkyscannerQuery(homeAirport, iataCode, currency)),
      });
      if (!pollRes.ok) break;
      data = await pollRes.json();
    }

    const flight = parseSkyscannerResult(data, homeAirport, iataCode, currency);
    res.json(flight || { error: "No flight found" });
  } catch (err: any) {
    console.error("[Backend] Flight error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

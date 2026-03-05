// ─── Farewave 2.0 · Netlify Function ───────────────────────
// Dos modos: búsqueda normal + exploración por presupuesto
// ───────────────────────────────────────────────────────────

const https = require("https");
const querystring = require("querystring");

const KEY    = process.env.AMADEUS_KEY;
const SECRET = process.env.AMADEUS_SECRET;
const BASE   = "test.api.amadeus.com";

let tokenCache = { value: null, expiresAt: 0 };

const AIRLINE_NAMES = {
  "AV":"Avianca","LA":"LATAM","CM":"Copa Airlines","IB":"Iberia",
  "AA":"American Airlines","DL":"Delta","UA":"United","BA":"British Airways",
  "AF":"Air France","KL":"KLM","LH":"Lufthansa","UX":"Air Europa",
  "VY":"Vueling","FR":"Ryanair","U2":"easyJet","PU":"Plus Ultra",
  "JJ":"LATAM Brasil","G3":"Gol","AD":"Azul","2Z":"Voepass",
};

const CITY_NAMES = {
  "MAD":"Madrid","BCN":"Barcelona","MIA":"Miami","JFK":"Nueva York",
  "LAX":"Los Ángeles","ORD":"Chicago","MCO":"Orlando","CDG":"París",
  "LHR":"Londres","AMS":"Ámsterdam","FCO":"Roma","MXP":"Milán",
  "FRA":"Frankfurt","EZE":"Buenos Aires","LIM":"Lima","SCL":"Santiago",
  "GRU":"São Paulo","GIG":"Río de Janeiro","MEX":"Ciudad de México",
  "CUN":"Cancún","GDL":"Guadalajara","MTY":"Monterrey","BOG":"Bogotá",
  "MDE":"Medellín","CLO":"Cali","CTG":"Cartagena","UIO":"Quito",
  "PTY":"Panamá","SJO":"San José","PUJ":"Punta Cana","HAV":"La Habana",
  "SDQ":"Santo Domingo","DXB":"Dubai","YYZ":"Toronto","NRT":"Tokio",
};

function httpsPost(path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:BASE, path, method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded", "Content-Length":Buffer.byteLength(body) }
    }, res => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on("error",reject); req.write(body); req.end();
  });
}

function httpsGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:BASE, path, method:"GET",
      headers:{ Authorization:`Bearer ${token}` }
    }, res => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on("error",reject); req.end();
  });
}

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const body = querystring.stringify({ grant_type:"client_credentials", client_id:KEY, client_secret:SECRET });
  const data = await httpsPost("/v1/security/oauth2/token", body);
  tokenCache = { value:data.access_token, expiresAt:Date.now()+data.expires_in*1000-60000 };
  return data.access_token;
}

function formatDuration(iso) {
  const m = iso.match(/PT(\d+H)?(\d+M)?/);
  const h = m?.[1]?parseInt(m[1]):0, min = m?.[2]?parseInt(m[2]):0;
  return `${h}h${min>0?min+"m":""}`;
}

// ── Modo 1: Búsqueda personalizada ────────────────────────
async function searchFlights({ origin, destination, departureDate, returnDate, passengers, budget }) {
  const token = await getToken();
  const params = querystring.stringify({
    originLocationCode: origin, destinationLocationCode: destination,
    departureDate, ...(returnDate ? { returnDate } : {}),
    adults: passengers || 1, max: 6, currencyCode: "COP",
  });

  const result = await httpsGet(`/v2/shopping/flight-offers?${params}`, token);
  const offers = result.data || [];

  if (!offers.length) return {
    summary: `No encontré vuelos de ${origin} a ${destination} para esas fechas. Intenta con otras fechas.`,
    flights: [], mode: "search"
  };

  const prices = offers.map(o => parseFloat(o.price.total));
  const minPrice = Math.min(...prices);

  // Filtrar por presupuesto si se especificó
  const filtered = budget
    ? offers.filter(o => parseFloat(o.price.total) <= budget)
    : offers;

  const toUse = (filtered.length ? filtered : offers).slice(0, 4);

  const flights = toUse.map(offer => {
    const itin = offer.itineraries;
    const seg0 = itin[0].segments;
    const first = seg0[0], last = seg0[seg0.length-1];
    const price = Math.round(parseFloat(offer.price.total));
    const stops = seg0.length - 1;
    let connectionInfo = null;
    if (stops > 0) {
      const city = seg0[0].arrival.iataCode;
      const wait = seg0[1]?.departure.at ? Math.round((new Date(seg0[1].departure.at)-new Date(seg0[0].arrival.at))/3600000)+"h espera" : "";
      connectionInfo = `${city}${wait?" ("+wait+")":""}`;
    }
    // Vuelo de regreso
    let returnInfo = null;
    if (itin[1]) {
      const seg1 = itin[1].segments;
      returnInfo = {
        departure: seg1[0].departure.at.slice(11,16),
        arrival: seg1[seg1.length-1].arrival.at.slice(11,16),
        duration: formatDuration(itin[1].duration),
        stops: seg1.length - 1,
      };
    }
    const airline = offer.validatingAirlineCodes?.[0] || first.carrierCode;
    return {
      airline: AIRLINE_NAMES[airline] || airline,
      from: first.departure.iataCode, to: last.arrival.iataCode,
      departure: first.departure.at.slice(11,16), arrival: last.arrival.at.slice(11,16),
      departureDate: first.departure.at.slice(0,10),
      duration: formatDuration(itin[0].duration),
      stops, connectionInfo, returnInfo, price,
      best: price === Math.round(minPrice),
    };
  });

  const lowestFmt = `$${Math.round(Math.min(...flights.map(f=>f.price))).toLocaleString("es-CO")}`;
  const directs = flights.filter(f=>f.stops===0).length;
  const withinBudget = budget ? flights.filter(f=>f.price<=budget).length : flights.length;

  return {
    summary: budget && filtered.length === 0
      ? `No encontré vuelos de ${origin} a ${destination} dentro de tu presupuesto de $${budget.toLocaleString("es-CO")} COP. Te muestro las opciones más económicas disponibles.`
      : `Encontré ${flights.length} vuelo${flights.length>1?"s":""} de ${origin} a ${destination}${returnDate?" (ida y vuelta)":""}. El más económico desde ${lowestFmt} COP${directs>0?", con "+directs+" directo"+(directs>1?"s":""):"."}.`,
    flights, mode: "search",
  };
}

// ── Modo 2: Exploración por presupuesto ───────────────────
async function exploreByBudget({ origin, budget, departureDate, oneWay }) {
  const token = await getToken();

  // Convertir COP a USD aproximado para Amadeus (tasa ~4000 COP/USD)
  const budgetUSD = Math.round(budget / 4000);

  const params = querystring.stringify({
    origin, maxPrice: budgetUSD,
    ...(departureDate ? { departureDate } : {}),
    ...(oneWay ? { oneWay: true } : {}),
    currency: "USD", viewBy: "DESTINATION",
  });

  const result = await httpsGet(`/v1/shopping/flight-destinations?${params}`, token);
  const data = result.data || [];

  if (!data.length) return {
    summary: `No encontré destinos disponibles desde ${origin} con ese presupuesto. Intenta aumentando un poco el presupuesto.`,
    destinations: [], mode: "explore"
  };

  const destinations = data.slice(0, 12).map(d => {
    const priceCOP = Math.round(d.price.total * 4000);
    return {
      code: d.destination,
      city: CITY_NAMES[d.destination] || d.destination,
      price: priceCOP,
      departureDate: d.departureDate,
      returnDate: d.returnDate,
      airline: d.links?.flightOffers ? "Ver vuelos" : null,
    };
  }).sort((a,b) => a.price - b.price);

  const cheapest = destinations[0];
  return {
    summary: `Con $${budget.toLocaleString("es-CO")} COP desde ${origin} puedes llegar a ${destinations.length} destinos. El más económico es ${cheapest.city} desde $${cheapest.price.toLocaleString("es-CO")} COP.`,
    destinations, mode: "explore",
    origin, budget,
  };
}

// ── Handler ────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode:200, headers, body:"" };
  if (event.httpMethod !== "POST") return { statusCode:405, headers, body:JSON.stringify({error:"Método no permitido"}) };

  try {
    const body = JSON.parse(event.body || "{}");

    if (body.mode === "explore") {
      const result = await exploreByBudget(body);
      return { statusCode:200, headers, body:JSON.stringify(result) };
    } else {
      const result = await searchFlights(body);
      return { statusCode:200, headers, body:JSON.stringify(result) };
    }
  } catch(err) {
    console.error(err);
    return { statusCode:500, headers, body:JSON.stringify({ error:"Error conectando con Amadeus. Verifica tus credenciales." }) };
  }
};

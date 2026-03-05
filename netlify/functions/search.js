// ─── Farewave · Netlify Function ───────────────────────────
// Parser de lenguaje natural integrado — sin API externa
// ───────────────────────────────────────────────────────────

const https = require("https");
const querystring = require("querystring");

const KEY    = process.env.AMADEUS_KEY;
const SECRET = process.env.AMADEUS_SECRET;
const BASE   = "test.api.amadeus.com";

let tokenCache = { value: null, expiresAt: 0 };

// ── Ciudades → IATA ────────────────────────────────────────
const CITIES = {
  "bogota":"BOG","bogotá":"BOG","medellin":"MDE","medellín":"MDE",
  "cali":"CLO","cartagena":"CTG","barranquilla":"BAQ","bucaramanga":"BGA",
  "pereira":"PEI","manizales":"MZL","armenia":"AXM","cucuta":"CUC",
  "mexico":"MEX","ciudad de mexico":"MEX","ciudad de méxico":"MEX","cdmx":"MEX",
  "cancun":"CUN","cancún":"CUN","guadalajara":"GDL","monterrey":"MTY",
  "buenos aires":"EZE","lima":"LIM","santiago":"SCL",
  "madrid":"MAD","barcelona":"BCN","paris":"CDG","parís":"CDG",
  "london":"LHR","londres":"LHR","amsterdam":"AMS","frankfurt":"FRA",
  "roma":"FCO","rome":"FCO","milan":"MXP","milán":"MXP",
  "miami":"MIA","nueva york":"JFK","new york":"JFK","nyc":"JFK",
  "los angeles":"LAX","los ángeles":"LAX","chicago":"ORD","orlando":"MCO",
  "sao paulo":"GRU","são paulo":"GRU","rio de janeiro":"GIG","rio":"GIG",
  "quito":"UIO","panama":"PTY","panamá":"PTY",
  "san jose":"SJO","san josé":"SJO","punta cana":"PUJ",
  "dubai":"DXB","toronto":"YYZ","montreal":"YUL",
  "habana":"HAV","la habana":"HAV","havana":"HAV",
  "santo domingo":"SDQ","san juan":"SJU",
};

const MONTHS = {
  "enero":"01","febrero":"02","marzo":"03","abril":"04",
  "mayo":"05","junio":"06","julio":"07","agosto":"08",
  "septiembre":"09","octubre":"10","noviembre":"11","diciembre":"12",
};

// ── Parser de lenguaje natural ─────────────────────────────
function parseMessage(raw) {
  // Normalizar: minúsculas, quitar tildes para matching
  const t = raw.toLowerCase()
    .replace(/á/g,"a").replace(/é/g,"e").replace(/í/g,"i")
    .replace(/ó/g,"o").replace(/ú/g,"u").replace(/ñ/g,"n");

  // Encontrar ciudades (de más larga a más corta para evitar falsos positivos)
  const sortedCities = Object.entries(CITIES).sort((a,b) => b[0].length - a[0].length);
  const found = [];
  for (const [city, code] of sortedCities) {
    const normalized = city.replace(/á/g,"a").replace(/é/g,"e").replace(/í/g,"i")
      .replace(/ó/g,"o").replace(/ú/g,"u").replace(/ñ/g,"n");
    const idx = t.indexOf(normalized);
    if (idx !== -1 && !found.find(f => f.code === code)) {
      found.push({ city, code, pos: idx });
    }
  }
  found.sort((a,b) => a.pos - b.pos);

  // Detectar origen/destino por posición relativa a "de", "a"
  let origin = null, destination = null;
  const dePos = t.search(/\bde\b|\bdesde\b/);
  const aPos  = t.search(/\ba\b|\bhasta\b|\bhacia\b|\bpara\b/);

  if (found.length >= 2) {
    // La que aparece primero después de "de" = origen, después de "a" = destino
    if (dePos !== -1 && aPos !== -1) {
      const beforeA = found.filter(f => f.pos > dePos && f.pos < aPos);
      const afterA  = found.filter(f => f.pos > aPos);
      if (beforeA.length) origin = beforeA[0].code;
      if (afterA.length)  destination = afterA[0].code;
    }
    // Fallback: primera = origen, segunda = destino
    if (!origin)      origin      = found[0].code;
    if (!destination) destination = found[1]?.code;
  } else if (found.length === 1) {
    destination = found[0].code;
  }

  // ── Fecha ──
  let date = null;
  const today = new Date();
  const y = today.getFullYear();

  const isoDate   = raw.match(/(\d{4}-\d{2}-\d{2})/);
  const slashDate = raw.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  const dayMonth  = t.match(/(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
  const monthOnly = t.match(/(?:en|para|durante|de)\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
  const thisWeek  = t.includes("esta semana") || t.includes("este fin de semana");
  const nextWeek  = t.includes("proxima semana") || t.includes("próxima semana");
  const thisMonth = t.includes("este mes");

  if (isoDate) {
    date = isoDate[1];
  } else if (slashDate) {
    const d = slashDate[1].padStart(2,"0");
    const m = slashDate[2].padStart(2,"0");
    const yr = slashDate[3] || y;
    date = `${yr}-${m}-${d}`;
  } else if (dayMonth) {
    const mon = MONTHS[dayMonth[2]];
    const dy  = dayMonth[1].padStart(2,"0");
    const yr  = today.getMonth()+1 > parseInt(mon) ? y+1 : y;
    date = `${yr}-${mon}-${dy}`;
  } else if (monthOnly) {
    const mon = MONTHS[monthOnly[1]];
    const yr  = today.getMonth()+1 > parseInt(mon) ? y+1 : y;
    date = `${yr}-${mon}-01`;
  } else if (thisWeek) {
    const d = new Date(today.getTime() + 2*24*60*60*1000);
    date = d.toISOString().split("T")[0];
  } else if (nextWeek) {
    const d = new Date(today.getTime() + 7*24*60*60*1000);
    date = d.toISOString().split("T")[0];
  } else if (thisMonth) {
    date = `${y}-${String(today.getMonth()+1).padStart(2,"0")}-15`;
  } else {
    // Default: 30 días
    const d = new Date(today.getTime() + 30*24*60*60*1000);
    date = d.toISOString().split("T")[0];
  }

  // ── Pasajeros ──
  let passengers = 1;
  const pax1 = raw.match(/(\d+)\s*(?:personas?|pasajeros?|adultos?|tiquetes?|tickets?)/i);
  const pax2 = raw.match(/para\s+(\d+)\s*(?:personas?|pasajeros?)?/i);
  if (pax1) passengers = Math.min(9, parseInt(pax1[1]));
  else if (pax2) passengers = Math.min(9, parseInt(pax2[1]));

  return { origin, destination, date, passengers };
}

// ── HTTPS helpers ──────────────────────────────────────────
function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method:"POST", headers }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method:"GET", headers }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const body = querystring.stringify({
    grant_type: "client_credentials",
    client_id: KEY, client_secret: SECRET,
  });
  const data = await httpsPost(BASE, "/v1/security/oauth2/token", body, {
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": Buffer.byteLength(body),
  });
  tokenCache = { value: data.access_token, expiresAt: Date.now() + data.expires_in*1000 - 60000 };
  return data.access_token;
}

function formatDuration(iso) {
  const m = iso.match(/PT(\d+H)?(\d+M)?/);
  const h = m?.[1] ? parseInt(m[1]) : 0;
  const min = m?.[2] ? parseInt(m[2]) : 0;
  return `${h}h${min > 0 ? min+"m" : ""}`;
}

// ── Handler ────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode:200, headers, body:"" };
  if (event.httpMethod !== "POST")    return { statusCode:405, headers, body: JSON.stringify({ error:"Método no permitido" }) };

  try {
    const { message } = JSON.parse(event.body || "{}");
    if (!message) return { statusCode:400, headers, body: JSON.stringify({ error:"No recibí ningún mensaje." }) };

    const { origin, destination, date, passengers } = parseMessage(message);

    if (!origin || !destination) {
      return { statusCode:200, headers, body: JSON.stringify({
        error: `No pude identificar el origen o destino en tu mensaje. Intenta así: "Vuelo de Bogotá a Madrid en julio para 2 personas".`,
      })};
    }

    const token = await getToken();
    const params = querystring.stringify({
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate: date,
      adults: passengers,
      max: 5,
      currencyCode: "COP",
    });

    const result = await httpsGet(BASE, `/v2/shopping/flight-offers?${params}`, {
      Authorization: `Bearer ${token}`,
    });

    const offers = result.data || [];

    if (!offers.length) {
      return { statusCode:200, headers, body: JSON.stringify({
        summary: `No encontré vuelos de ${origin} a ${destination} para el ${date}. Prueba con otras fechas.`,
        flights: [],
      })};
    }

    const prices   = offers.map(o => parseFloat(o.price.total));
    const minPrice = Math.min(...prices);

    const flights = offers.slice(0,4).map(offer => {
      const seg   = offer.itineraries[0].segments;
      const first = seg[0];
      const last  = seg[seg.length-1];
      const price = Math.round(parseFloat(offer.price.total));
      const stops = seg.length - 1;
      let connectionInfo = null;
      if (stops > 0) {
        const city = seg[0].arrival.iataCode;
        const wait = seg[1]?.departure.at
          ? Math.round((new Date(seg[1].departure.at) - new Date(seg[0].arrival.at))/3600000)+"h espera"
          : "";
        connectionInfo = `${city}${wait ? " ("+wait+")" : ""}`;
      }
      return {
        airline:   offer.validatingAirlineCodes?.[0] || first.carrierCode,
        from:      first.departure.iataCode,
        to:        last.arrival.iataCode,
        departure: first.departure.at.slice(11,16),
        arrival:   last.arrival.at.slice(11,16),
        duration:  formatDuration(offer.itineraries[0].duration),
        stops, connectionInfo, price,
        best: price === Math.round(minPrice),
      };
    });

    const lowestFmt = `$${Math.round(minPrice).toLocaleString("es-CO")}`;
    const directs   = flights.filter(f => f.stops===0).length;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        summary: `Encontré ${flights.length} vuelos de ${origin} a ${destination} para el ${date}${passengers>1?", "+passengers+" pasajeros":""}. El más económico sale desde ${lowestFmt} COP${directs>0?", con "+directs+" vuelo"+(directs>1?"s":"")+" directo"+(directs>1?"s":""):"."}.`,
        flights,
      }),
    };

  } catch (err) {
    console.error(err);
    return { statusCode:500, headers, body: JSON.stringify({ error:"Error conectando con Amadeus. Verifica tus credenciales en Netlify." }) };
  }
};

// ─── Farewave 2.0 · Netlify Function ───────────────────────
// Incluye algoritmo de Ruta Inteligente (vuelos partidos)
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
  "VY":"Vueling","PU":"Plus Ultra","JJ":"LATAM Brasil","G3":"Gol",
  "AD":"Azul","AM":"Aeroméxico","AC":"Air Canada","QR":"Qatar Airways",
  "EK":"Emirates","TK":"Turkish Airlines","JL":"Japan Airlines","NH":"ANA",
};

const CITY_NAMES = {
  "MAD":"Madrid","BCN":"Barcelona","MIA":"Miami","JFK":"Nueva York",
  "LAX":"Los Ángeles","ORD":"Chicago","MCO":"Orlando","CDG":"París",
  "LHR":"Londres","AMS":"Ámsterdam","FCO":"Roma","MXP":"Milán",
  "FRA":"Frankfurt","EZE":"Buenos Aires","LIM":"Lima","SCL":"Santiago",
  "GRU":"São Paulo","GIG":"Río de Janeiro","MEX":"Ciudad de México",
  "CUN":"Cancún","BOG":"Bogotá","MDE":"Medellín","CLO":"Cali",
  "UIO":"Quito","PTY":"Panamá","PUJ":"Punta Cana","HAV":"La Habana",
  "DXB":"Dubai","DOH":"Doha","YYZ":"Toronto","NRT":"Tokio",
  "ICN":"Seúl","SIN":"Singapur","BKK":"Bangkok","SYD":"Sídney",
  "HKG":"Hong Kong","PEK":"Pekín","PVG":"Shanghai",
};

// Hubs estratégicos por región — los que más vuelos conectan
const HUBS = {
  "americas": ["BOG","MIA","JFK","LAX","GRU","PTY","MEX","LIM","EZE","SCL"],
  "europe":   ["MAD","LHR","CDG","AMS","FRA","FCO","LIS","BCN"],
  "asia":     ["DXB","DOH","ICN","NRT","SIN","BKK","HKG","IST"],
  "all":      ["BOG","MIA","JFK","LAX","GRU","PTY","MEX","MAD","LHR","CDG","AMS","FRA","DXB","DOH","ICN","NRT","LIM","EZE"],
};

function getHubsForRoute(origin, destination) {
  // Detectar región destino para elegir hubs relevantes
  const asianDests = ["NRT","ICN","SIN","BKK","HKG","PEK","PVG","SYD","KUL","MNL","DEL","BOM"];
  const europeanDests = ["MAD","LHR","CDG","AMS","FRA","FCO","MXP","BCN","LIS","VIE","ZRH","CPH","ARN"];
  const northAmDests = ["JFK","LAX","MIA","ORD","MCO","SFO","LAS","SEA","ATL","DFW","YYZ","YVR"];

  if (asianDests.includes(destination)) {
    return [...HUBS.americas.filter(h=>h!==origin), ...HUBS.asia.filter(h=>h!==destination), ...HUBS.europe].slice(0,12);
  }
  if (europeanDests.includes(destination)) {
    return [...HUBS.americas.filter(h=>h!==origin), ...HUBS.europe.filter(h=>h!==destination)].slice(0,10);
  }
  if (northAmDests.includes(destination)) {
    return [...HUBS.americas.filter(h=>h!==origin&&h!==destination)].slice(0,8);
  }
  return HUBS.all.filter(h=>h!==origin&&h!==destination).slice(0,10);
}

// ── HTTPS helpers ──────────────────────────────────────────
function httpsPost(path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname:BASE, path, method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(body)}
    }, res => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on("error",reject); req.write(body); req.end();
  });
}

function httpsGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname:BASE, path, method:"GET",
      headers:{Authorization:`Bearer ${token}`}
    }, res => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on("error",reject); req.end();
  });
}

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const body = querystring.stringify({grant_type:"client_credentials",client_id:KEY,client_secret:SECRET});
  const data = await httpsPost("/v1/security/oauth2/token", body);
  tokenCache = { value:data.access_token, expiresAt:Date.now()+data.expires_in*1000-60000 };
  return data.access_token;
}

function formatDuration(iso) {
  const m = iso.match(/PT(\d+H)?(\d+M)?/);
  const h = m?.[1]?parseInt(m[1]):0, min=m?.[2]?parseInt(m[2]):0;
  return `${h}h${min>0?min+"m":""}`;
}

function addDurations(d1, d2) {
  const parse = d => { const m=d.match(/(\d+)h(\d+)?m?/); return (parseInt(m?.[1]||0)*60)+(parseInt(m?.[2]||0)); };
  const total = parse(d1)+parse(d2);
  return `${Math.floor(total/60)}h${total%60>0?total%60+"m":""}`;
}

// ── Buscar un tramo con manejo de errores ──────────────────
async function searchLeg(origin, destination, date, passengers, token, currency="COP") {
  try {
    const params = querystring.stringify({
      originLocationCode:origin, destinationLocationCode:destination,
      departureDate:date, adults:passengers, max:2, currencyCode:currency,
    });
    const r = await httpsGet(`/v2/shopping/flight-offers?${params}`, token);
    return r.data || [];
  } catch(e) { return []; }
}

// ── Convertir oferta Amadeus a nuestro formato ─────────────
function parseOffer(offer, label) {
  const itin = offer.itineraries[0];
  const seg  = itin.segments;
  const first= seg[0], last=seg[seg.length-1];
  const price= Math.round(parseFloat(offer.price.total));
  const stops= seg.length-1;
  let connectionInfo=null;
  if (stops>0) {
    const city=seg[0].arrival.iataCode;
    const wait=seg[1]?.departure.at?Math.round((new Date(seg[1].departure.at)-new Date(seg[0].arrival.at))/3600000)+"h espera":"";
    connectionInfo=`${city}${wait?" ("+wait+")":""}`;
  }
  const airlineCode = offer.validatingAirlineCodes?.[0]||first.carrierCode;
  return {
    airline: AIRLINE_NAMES[airlineCode]||airlineCode,
    from: first.departure.iataCode, to: last.arrival.iataCode,
    departure: first.departure.at.slice(11,16), arrival: last.arrival.at.slice(11,16),
    departureDate: first.departure.at.slice(0,10),
    duration: formatDuration(itin.duration),
    stops, connectionInfo, price,
    label: label||null, best:false,
  };
}

// ── Modo 1: Búsqueda con Ruta Inteligente ─────────────────
async function searchFlights({ origin, destination, departureDate, returnDate, passengers, budget, smartRoute, currency="COP" }) {
  const token = await getToken();
  const pax = passengers||1;

  // 1. Buscar vuelo directo
  const directOffers = await searchLeg(origin, destination, departureDate, pax, token, currency);

  // 2. Si smartRoute activo, buscar rutas partidas en paralelo
  let smartRoutes = [];
  if (smartRoute !== false) {
    const hubs = getHubsForRoute(origin, destination);
    const routePromises = hubs.map(async hub => {
      try {
        const [leg1Offers, leg2Offers] = await Promise.all([
          searchLeg(origin, hub, departureDate, pax, token, currency),
          searchLeg(hub, destination, departureDate, pax, token, currency),
        ]);
        if (!leg1Offers.length || !leg2Offers.length) return null;
        const leg1 = leg1Offers[0], leg2 = leg2Offers[0];
        const price1 = parseFloat(leg1.price.total);
        const price2 = parseFloat(leg2.price.total);
        const totalPrice = Math.round(price1 + price2);

        // Verificar que haya tiempo suficiente entre vuelos (mínimo 3h)
        const arr1 = new Date(leg1.itineraries[0].segments[leg1.itineraries[0].segments.length-1].arrival.at);
        const dep2 = new Date(leg2.itineraries[0].segments[0].departure.at);
        const layoverHours = (dep2-arr1)/3600000;
        if (layoverHours < 2 || layoverHours > 48) return null;

        const f1 = parseOffer(leg1, "Tramo 1");
        const f2 = parseOffer(leg2, "Tramo 2");

        return {
          hub, hubCity: CITY_NAMES[hub]||hub,
          price: totalPrice,
          leg1: f1, leg2: f2,
          totalDuration: addDurations(f1.duration, f2.duration),
          layoverHours: Math.round(layoverHours*10)/10,
          tickets: 2,
          isSmartRoute: true,
        };
      } catch(e) { return null; }
    });

    const results = await Promise.allSettled(routePromises);
    smartRoutes = results
      .filter(r => r.status==="fulfilled" && r.value)
      .map(r => r.value)
      .sort((a,b) => a.price-b.price)
      .slice(0, 3);
  }

  if (!directOffers.length && !smartRoutes.length) {
    return { summary:`No encontré vuelos de ${origin} a ${destination} para esas fechas.`, flights:[], smartRoutes:[], mode:"search" };
  }

  // Procesar vuelos directos
  const prices = directOffers.map(o=>parseFloat(o.price.total));
  const minPrice = Math.min(...prices);
  const filtered = budget ? directOffers.filter(o=>parseFloat(o.price.total)<=budget) : directOffers;
  const toUse = (filtered.length?filtered:directOffers).slice(0,4);
  const flights = toUse.map(offer => {
    const f = parseOffer(offer, null);
    f.best = f.price===Math.round(minPrice);
    return f;
  });

  // Marcar si la ruta inteligente es más barata que el directo
  const directMin = flights.length ? Math.min(...flights.map(f=>f.price)) : Infinity;
  const smartMin  = smartRoutes.length ? smartRoutes[0].price : Infinity;
  const saving    = directMin - smartMin;

  let summary = "";
  if (flights.length) {
    summary = `Encontré ${flights.length} vuelo${flights.length>1?"s":""} de ${origin} a ${destination}. El más económico desde $${Math.round(directMin).toLocaleString("es-CO")} COP`;
    if (saving>0 && smartRoutes.length) {
      summary += `. ✨ También encontré una Ruta Inteligente que ahorra $${saving.toLocaleString("es-CO")} COP viajando via ${smartRoutes[0].hubCity}.`;
    } else if (!flights.length && smartRoutes.length) {
      summary = `No hay vuelos directos pero encontré una Ruta Inteligente via ${smartRoutes[0].hubCity} por $${smartMin.toLocaleString("es-CO")} COP.`;
    } else {
      summary += ".";
    }
  } else if (smartRoutes.length) {
    summary = `No encontré vuelo directo de ${origin} a ${destination} pero hay una Ruta Inteligente via ${smartRoutes[0].hubCity} por $${smartMin.toLocaleString("es-CO")} COP.`;
  }

  return { summary, flights, smartRoutes, directMin, smartMin, saving: saving>0?saving:0, mode:"search", currency };
}

// ── Modo 2: Exploración por presupuesto ───────────────────
// ── Modo 2: Exploración por presupuesto (búsquedas reales en paralelo) ──
async function exploreByBudget({ origin, budget, departureDate, currency="COP" }) {
  const token = await getToken();

  // Fecha por defecto: 30 días desde hoy
  const date = departureDate || (() => {
    const d = new Date(); d.setDate(d.getDate()+30);
    return d.toISOString().split("T")[0];
  })();

  // Destinos populares a explorar (excluimos el origen)
  const POPULAR = ["MAD","MIA","JFK","LAX","CDG","LHR","CUN","MEX","PTY","BOG",
    "MDE","EZE","LIM","GRU","SCL","BCN","AMS","FRA","FCO","MCO","ORD","DXB",
    "NRT","ICN","SIN","YYZ","PUJ","HAV","SDQ","UIO","CTG","BAQ"];

  const targets = POPULAR.filter(d => d !== origin);

  // Buscar en paralelo (máx 20 a la vez)
  const results = await Promise.allSettled(
    targets.slice(0,20).map(async dest => {
      try {
        const params = querystring.stringify({
          originLocationCode: origin,
          destinationLocationCode: dest,
          departureDate: date,
          adults: 1,
          max: 1,
          currencyCode: currency,
        });
        const r = await httpsGet(`/v2/shopping/flight-offers?${params}`, token);
        const offer = r.data?.[0];
        if (!offer) return null;
        const price = Math.round(parseFloat(offer.price.total));
        if (price > budget) return null;
        const seg = offer.itineraries[0].segments;
        return {
          code: dest,
          city: CITY_NAMES[dest] || dest,
          price,
          departureDate: date,
          stops: seg.length - 1,
          duration: formatDuration(offer.itineraries[0].duration),
        };
      } catch(e) { return null; }
    })
  );

  const destinations = results
    .filter(r => r.status==="fulfilled" && r.value)
    .map(r => r.value)
    .sort((a,b) => a.price - b.price);

  const rates = { COP:4000, USD:1, EUR:0.92, ARS:900, MXN:17, PEN:3.7, CLP:950, BRL:5, GBP:0.79 };
  const sym = { COP:"$",USD:"US$",EUR:"€",ARS:"$",MXN:"$",PEN:"S/",CLP:"$",BRL:"R$",GBP:"£" }[currency]||"$";

  if (!destinations.length) return {
    summary: `No encontré destinos desde ${CITY_NAMES[origin]||origin} dentro de ${sym}${budget.toLocaleString()} ${currency} para el ${date}. Prueba con un presupuesto mayor o fecha diferente.`,
    destinations: [], mode:"explore", origin, budget, currency,
  };

  const cheapest = destinations[0];
  return {
    summary: `Con ${sym}${budget.toLocaleString()} ${currency} desde ${CITY_NAMES[origin]||origin} puedes volar a ${destinations.length} destinos. El más económico es ${cheapest.city} desde ${sym}${cheapest.price.toLocaleString()} ${currency}.`,
    destinations, mode:"explore", origin, budget, currency,
  };
}

// ── Handler ────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type",
    "Content-Type":"application/json",
  };
  if (event.httpMethod==="OPTIONS") return {statusCode:200,headers,body:""};
  if (event.httpMethod!=="POST")    return {statusCode:405,headers,body:JSON.stringify({error:"Método no permitido"})};
  try {
    const body = JSON.parse(event.body||"{}");
    const result = body.mode==="explore" ? await exploreByBudget(body) : await searchFlights(body);
    return {statusCode:200,headers,body:JSON.stringify(result)};
  } catch(err) {
    console.error(err);
    return {statusCode:500,headers,body:JSON.stringify({error:"Error conectando con Amadeus."})};
  }
};

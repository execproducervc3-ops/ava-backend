// mcp-server.js — CommonJS format, matching every other function in this
// project. The .mjs (ESM) version repeatedly failed to resolve
// '@supabase/supabase-js' at runtime on Netlify's servers, even with
// external_node_modules correctly configured — the one common factor
// across both failures was that it was the only ESM function in the whole
// codebase. Every CommonJS function here has always resolved this same
// dependency correctly, so this rewrites the server to match that proven,
// working pattern instead of trying a third variation on the ESM approach.

const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { toFetchResponse, toReqRes } = require('fetch-to-node');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

const ava = require('./ava-core.js');

function asToolResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function getServer() {
  const server = new McpServer(
    { name: "ava-svg-server", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  server.tool(
    "query_retail_price",
    "Real, live retail price comparison across AVA's directory of Saint Vincent and the Grenadines retailers, normalized per standard unit so different package sizes compare fairly.",
    { product_name: z.string().describe("Product to search for, e.g. 'rice' or 'chicken wings'") },
    async ({ product_name }) => asToolResult(await ava.queryRetailPriceDB(product_name))
  );

  server.tool(
    "query_news",
    "Real news articles from AVA's own ingested SVG news sources.",
    { topic: z.string().describe("News topic or keyword to search for") },
    async ({ topic }) => asToolResult(await ava.queryNewsDB(topic))
  );

  server.tool(
    "query_economic_data",
    "Real economic indicators for SVG.",
    { indicator: z.string().describe("Economic indicator to look up") },
    async ({ indicator }) => asToolResult(await ava.queryEconomicData(indicator))
  );

  server.tool(
    "query_imf_data",
    "Real IMF economic data for SVG.",
    { indicator: z.string().describe("IMF indicator to look up") },
    async ({ indicator }) => asToolResult(await ava.queryImfData(indicator))
  );

  server.tool(
    "query_ferry_schedule",
    "Real inter-island ferry schedules for SVG.",
    {
      destination: z.string().describe("Ferry destination, e.g. 'Bequia'"),
      day_of_week: z.string().optional().describe("Optional day of week to filter by"),
    },
    async ({ destination, day_of_week }) => asToolResult(await ava.queryFerrySchedule(destination, day_of_week))
  );

  server.tool(
    "generate_lucky_numbers",
    "Generates real, valid lottery number sets for SVG's National Lottery games.",
    { game: z.string().describe("Lottery game, e.g. 'super6', 'lotto', '3d', 'play4'") },
    async ({ game }) => asToolResult(ava.generateLuckyNumbers(game))
  );

  server.tool(
    "query_directory",
    "Real local SVG business directory — restaurants, pharmacies, doctors, taxi services, accommodation, car rental, and more. If a specific business is named, always pass business_name — otherwise this returns an unfiltered category list.",
    {
      category: z.string().describe("Business category, e.g. 'restaurant', 'pharmacy', 'accommodation', 'car_rental', 'promoter', 'nightlife'"),
      island: z.string().optional().describe("Optional island to filter by"),
      business_name: z.string().optional().describe("If a specific business was named, pass it here to filter to just that one, e.g. 'Sky Lounge'"),
    },
    async ({ category, island, business_name }) => asToolResult(await ava.queryDirectory(category, island, business_name))
  );

  server.tool(
    "query_health_data",
    "Real WHO health indicator data for SVG.",
    { indicator: z.string().describe("Health indicator to look up") },
    async ({ indicator }) => asToolResult(await ava.queryHealthData(indicator))
  );

  server.tool(
    "query_fuel_context",
    "Real, current VINLEC fuel surcharge context for SVG, from the most recent relevant news coverage. Takes no parameters.",
    {},
    async () => asToolResult(await ava.queryFuelContext())
  );

  server.tool(
    "query_weather",
    "Real current weather and 3-day forecast for Saint Vincent and the Grenadines. Takes no parameters — always covers SVG specifically.",
    {},
    async () => asToolResult(await ava.queryWeather())
  );

  server.tool(
    "query_marine_conditions",
    "Real current marine and wave conditions for SVG waters. Takes no parameters.",
    {},
    async () => asToolResult(await ava.queryMarineConditions())
  );

  server.tool(
    "query_scholarships",
    "Real, currently open scholarship opportunities relevant to SVG. Takes no parameters.",
    {},
    async () => asToolResult(await ava.queryScholarships())
  );

  server.tool(
    "query_reference_knowledge",
    "AVA's own verified reference knowledge base about SVG — geography, history, government, culture, economy, practical travel info, music, or indigenous history.",
    { category: z.enum(["geography", "history", "government", "culture", "economy", "practical", "indigenous_peoples", "music"]) },
    async ({ category }) => asToolResult(await ava.queryReferenceKnowledge(category))
  );

  server.tool(
    "query_points_of_interest",
    "Real, researched beaches, hiking trails, waterfalls, historic sites, gardens, and marine parks across SVG. If a specific place is named, always pass place_name — otherwise this returns an unfiltered category list.",
    {
      category: z.string().optional().describe("Optional: 'beach', 'hiking_trail', 'waterfall', 'historic_site', 'marine_park', or 'garden'"),
      island: z.string().optional().describe("Optional island to filter by"),
      place_name: z.string().optional().describe("If a specific place was named, pass it here to filter to just that one, e.g. 'Macaroni Beach'"),
    },
    async ({ category, island, place_name }) => asToolResult(await ava.queryPointsOfInterest(category, island, place_name))
  );

  server.tool(
    "plan_trip",
    "Builds a full trip plan from one total budget — real live flight prices from Duffel, plus accommodation, car rental, and food from AVA's own local directory.",
    {
      origin: z.string().describe("Origin airport IATA code"),
      destination: z.string().describe("Destination airport IATA code"),
      departure_date: z.string().describe("Departure date, YYYY-MM-DD"),
      total_budget: z.number().describe("Total trip budget in USD"),
      island: z.string().describe("Island for accommodation/car/food listings"),
    },
    async ({ origin, destination, departure_date, total_budget, island }) =>
      asToolResult(await ava.planTrip(origin, destination, departure_date, total_budget, island))
  );

  server.tool(
    "query_taxi_fare",
    "Real official Ministry of Transport taxi fares for airport, Kingstown, and cruise-ship-berth routes, or a data-grounded estimate (clearly labeled) for any other route in SVG.",
    {
      origin: z.string().describe("Starting point, e.g. 'the airport' or 'Kingstown'"),
      destination: z.string().describe("Destination"),
    },
    async ({ origin, destination }) => asToolResult(await ava.queryTaxiFare(origin, destination))
  );

  server.tool(
    "query_bus_fare",
    "Real official public bus fares in SVG, relative to five real hubs: Kingstown, Georgetown, Barrouallie, Paget Farm, Port Elizabeth.",
    {
      origin: z.string().describe("Should include one of the five real hub names"),
      destination: z.string().describe("Destination place name"),
    },
    async ({ origin, destination }) => asToolResult(await ava.queryBusFare(origin, destination))
  );

  server.tool(
    "query_settlement_classification",
    "A place's official government development classification (National/District/Local Centre, Growth or Renewal), from SVG's National Physical Development Plan (2021 draft).",
    { place: z.string().describe("Settlement name, e.g. 'Georgetown'") },
    async ({ place }) => asToolResult(await ava.querySettlementClassification(place))
  );

  server.tool(
    "get_deep_link",
    "Builds a real deep link to an appropriate third-party or official government site for flights, hotels, car rental, events, customs duty, or voter registration — AVA never books or pays on anyone's behalf.",
    {
      service_type: z.enum(["flights", "hotels", "cars", "events", "customs_general", "customs_vehicle", "voter_registration"]),
      params: z.object({}).passthrough().optional().describe("Service-specific parameters, e.g. origin/destination for flights, location for hotels"),
    },
    async ({ service_type, params }) => asToolResult(ava.buildDeepLink(service_type, params))
  );

  return server;
}


exports.handler = async (event, context) => {
  try {
    // Netlify v1 functions don't provide a native Fetch API Request — it's
    // reconstructed manually from the Lambda-style event object, matching
    // the confirmed working pattern for CommonJS MCP servers on Netlify.
    const req = new Request(`https://${event.headers.host}${event.path}`, {
      method: event.httpMethod,
      headers: event.headers,
      body: event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : undefined,
    });

    if (req.method === "POST") {
      const { req: nodeReq, res: nodeRes } = toReqRes(req);
      const server = getServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);

      let body;
      try {
        body = await req.json();
      } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }

      await transport.handleRequest(nodeReq, nodeRes, body);
      nodeRes.on("close", () => {
        transport.close();
        server.close();
      });

      const response = await toFetchResponse(nodeRes);
      const responseBody = await response.text();
      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });

      return { statusCode: response.status, headers, body: responseBody };
    }

    return { statusCode: 405, body: "Method not allowed" };
  } catch (error) {
    console.error("MCP error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: "",
      }),
    };
  }
};

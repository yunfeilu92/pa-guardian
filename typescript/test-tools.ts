/**
 * Local test script for MCP tools.
 * Starts the server, sends MCP tool calls, and prints results.
 *
 * Usage: npx tsx test-tools.ts
 *
 * Requires a FHIR server URL. Defaults to HAPI FHIR public R4 server.
 * Set FHIR_SERVER_URL env var to override.
 * Set AWS credentials for Bedrock AI analysis (optional — gracefully degrades).
 */

const FHIR_SERVER_URL =
  process.env["FHIR_SERVER_URL"] || "https://hapi.fhir.org/baseR4";
const SERVER_URL = "http://localhost:5000/mcp";

async function findTestPatient(): Promise<string | null> {
  // Find a patient that has Observations
  const res = await fetch(
    `${FHIR_SERVER_URL}/Observation?category=laboratory&_count=1&_format=json`,
  );
  const bundle = await res.json();
  const entry = bundle?.entry?.[0];
  if (!entry) return null;
  const ref = entry.resource?.subject?.reference;
  if (!ref) return null;
  return ref.replace("Patient/", "");
}

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  patientId?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-fhir-server-url": FHIR_SERVER_URL,
  };
  if (patientId) {
    headers["x-patient-id"] = patientId;
  }

  // MCP initialize
  await fetch(SERVER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
      id: 1,
    }),
  });

  // List tools
  const listRes = await fetch(SERVER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 2,
    }),
  });
  const listData = await listRes.json();
  console.log(
    "\n📋 Available tools:",
    listData?.result?.tools?.map((t: { name: string }) => t.name) || "none",
  );

  // Call tool
  console.log(`\n🔧 Calling ${toolName} with args:`, args);
  const callRes = await fetch(SERVER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: 3,
    }),
  });
  const callData = await callRes.json();

  if (callData?.result?.content) {
    for (const c of callData.result.content) {
      if (c.type === "text") {
        console.log("\n📄 Result:\n");
        console.log(c.text);
      }
    }
  } else if (callData?.error) {
    console.error("❌ Error:", callData.error);
  } else {
    console.log("Raw response:", JSON.stringify(callData, null, 2));
  }
}

async function main() {
  console.log("🏥 MCP Tool Test Suite");
  console.log(`📡 FHIR Server: ${FHIR_SERVER_URL}`);
  console.log(`🔗 MCP Server: ${SERVER_URL}`);

  // Find a test patient
  console.log("\n🔍 Finding a test patient with lab data...");
  const patientId = await findTestPatient();
  if (!patientId) {
    console.error(
      "❌ Could not find a patient with lab data. Try a different FHIR server.",
    );
    process.exit(1);
  }
  console.log(`✅ Found patient: ${patientId}`);

  // Test 1: GetPatientAge
  await callMcpTool("GetPatientAge", { patientId });

  // Test 2: AnalyzeLabResults
  await callMcpTool("AnalyzeLabResults", { patientId, count: 5 });

  // Test 3: CheckDrugInteractions
  await callMcpTool("CheckDrugInteractions", { patientId });

  // Test 4: GenerateVisitSummary
  await callMcpTool("GenerateVisitSummary", { patientId });

  console.log("\n✅ All tests completed.");
}

main().catch(console.error);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";
import { invokeBedrockClaude } from "../bedrock-client";

class AnalyzeLabResultsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "AnalyzeLabResults",
      {
        description:
          "Retrieves and analyzes a patient's recent laboratory results from FHIR. " +
          "Returns lab values with reference ranges, flags abnormal results, " +
          "identifies trends, and generates a clinical summary highlighting " +
          "values that need attention.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The id of the patient. Optional if patient context already exists.",
            )
            .optional(),
          category: z
            .string()
            .describe(
              "Optional LOINC category to filter labs (e.g., 'laboratory', 'vital-signs'). Defaults to 'laboratory'.",
            )
            .optional(),
          count: z
            .number()
            .describe(
              "Maximum number of recent results to return. Defaults to 20.",
            )
            .optional(),
        },
      },
      async ({ patientId, category, count }) => {
        if (!patientId) {
          patientId = NullUtilities.getOrThrow(
            FhirUtilities.getPatientIdIfContextExists(req),
          );
        }

        const labCategory = category || "laboratory";
        const maxCount = count || 20;

        const bundle = await FhirClientInstance.search(
          req,
          "Observation",
          [
            `patient=${patientId}`,
            `category=${labCategory}`,
            `_sort=-date`,
            `_count=${maxCount}`,
          ],
        );

        if (!bundle || !bundle.entry || bundle.entry.length === 0) {
          return McpUtilities.createTextResponse(
            `No ${labCategory} results found for patient ${patientId}.`,
          );
        }

        const results: string[] = [];
        const abnormals: string[] = [];

        for (const entry of bundle.entry) {
          const obs = entry.resource as fhirR4.Observation;
          if (!obs) continue;

          const name =
            obs.code?.coding?.[0]?.display || obs.code?.text || "Unknown Test";
          const date = obs.effectiveDateTime || obs.issued || "Unknown date";
          const status = obs.status || "unknown";

          let value = "No value";
          let unit = "";

          if (obs.valueQuantity) {
            value = `${obs.valueQuantity.value}`;
            unit = obs.valueQuantity.unit || obs.valueQuantity.code || "";
          } else if (obs.valueString) {
            value = obs.valueString;
          } else if (obs.valueCodeableConcept) {
            value =
              obs.valueCodeableConcept.coding?.[0]?.display ||
              obs.valueCodeableConcept.text ||
              "coded value";
          }

          let refRange = "";
          if (obs.referenceRange && obs.referenceRange.length > 0) {
            const range = obs.referenceRange[0];
            const low = range.low?.value;
            const high = range.high?.value;
            const rangeUnit = range.low?.unit || range.high?.unit || unit;
            if (low !== undefined && high !== undefined) {
              refRange = ` (ref: ${low}-${high} ${rangeUnit})`;
            } else if (low !== undefined) {
              refRange = ` (ref: ≥${low} ${rangeUnit})`;
            } else if (high !== undefined) {
              refRange = ` (ref: ≤${high} ${rangeUnit})`;
            }
          }

          const interpretation =
            obs.interpretation?.[0]?.coding?.[0]?.code || "";
          let flag = "";
          if (
            interpretation === "H" ||
            interpretation === "HH" ||
            interpretation === "L" ||
            interpretation === "LL"
          ) {
            const flagLabel =
              interpretation === "HH"
                ? "⚠️ CRITICALLY HIGH"
                : interpretation === "H"
                  ? "🔴 HIGH"
                  : interpretation === "LL"
                    ? "⚠️ CRITICALLY LOW"
                    : "🔵 LOW";
            flag = ` [${flagLabel}]`;
            abnormals.push(`${name}: ${value} ${unit}${refRange}${flag}`);
          }

          results.push(
            `- ${name}: ${value} ${unit}${refRange}${flag} (${date}, ${status})`,
          );
        }

        let summary = `## Lab Results for Patient ${patientId}\n\n`;
        summary += `**Total results:** ${bundle.entry.length}\n\n`;

        if (abnormals.length > 0) {
          summary += `### ⚠️ Abnormal Values (${abnormals.length})\n`;
          for (const abn of abnormals) {
            summary += `- ${abn}\n`;
          }
          summary += `\n`;
        } else {
          summary += `### ✅ All values within normal range\n\n`;
        }

        summary += `### All Results\n`;
        summary += results.join("\n");

        // AI Clinical Analysis via Bedrock Claude
        try {
          const aiAnalysis = await invokeBedrockClaude(
            "You are a clinical laboratory specialist. Analyze the following lab results and provide: " +
              "1) Key clinical patterns or correlations between values, " +
              "2) Possible clinical significance of any abnormal values, " +
              "3) Recommended follow-up tests if applicable. " +
              "Be concise but clinically precise. Use medical terminology appropriate for a physician audience. " +
              "IMPORTANT: This is for clinical decision support only — always recommend verification with the source EHR.",
            `Patient lab results:\n${results.join("\n")}`,
          );
          summary += `\n\n### 🤖 AI Clinical Analysis (Powered by Amazon Bedrock)\n${aiAnalysis}`;
        } catch (error) {
          summary += `\n\n*AI analysis unavailable — displaying raw results only.*`;
        }

        return McpUtilities.createTextResponse(summary);
      },
    );
  }
}

export const AnalyzeLabResultsToolInstance = new AnalyzeLabResultsTool();

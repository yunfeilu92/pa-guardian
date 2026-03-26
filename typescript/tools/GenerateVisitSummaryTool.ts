import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";

class GenerateVisitSummaryTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GenerateVisitSummary",
      {
        description:
          "Generates a comprehensive pre-visit summary for a patient by " +
          "aggregating demographics, active conditions, medications, allergies, " +
          "recent lab results, and recent encounters from FHIR. " +
          "Designed to save clinicians time by consolidating scattered EHR data " +
          "into a single actionable briefing.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The id of the patient. Optional if patient context already exists.",
            )
            .optional(),
        },
      },
      async ({ patientId }) => {
        if (!patientId) {
          patientId = NullUtilities.getOrThrow(
            FhirUtilities.getPatientIdIfContextExists(req),
          );
        }

        const [
          patient,
          conditions,
          medications,
          allergies,
          recentLabs,
          encounters,
        ] = await Promise.all([
          FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`),
          FhirClientInstance.search(req, "Condition", [
            `patient=${patientId}`,
            `clinical-status=active`,
            `_count=20`,
          ]),
          FhirClientInstance.search(req, "MedicationRequest", [
            `patient=${patientId}`,
            `status=active`,
            `_count=20`,
          ]),
          FhirClientInstance.search(req, "AllergyIntolerance", [
            `patient=${patientId}`,
            `clinical-status=active`,
            `_count=10`,
          ]),
          FhirClientInstance.search(req, "Observation", [
            `patient=${patientId}`,
            `category=laboratory`,
            `_sort=-date`,
            `_count=10`,
          ]),
          FhirClientInstance.search(req, "Encounter", [
            `patient=${patientId}`,
            `_sort=-date`,
            `_count=5`,
          ]),
        ]);

        let summary = `# Pre-Visit Summary\n\n`;

        // Demographics
        if (patient) {
          const name = patient.name?.[0];
          const fullName = name
            ? `${name.given?.join(" ") || ""} ${name.family || ""}`.trim()
            : "Unknown";
          const gender = patient.gender || "Unknown";
          const birthDate = patient.birthDate || "Unknown";

          summary += `## Patient: ${fullName}\n`;
          summary += `- **DOB:** ${birthDate} | **Gender:** ${gender}\n`;
          summary += `- **ID:** ${patientId}\n\n`;
        } else {
          summary += `## Patient: ${patientId} (details unavailable)\n\n`;
        }

        // Active Conditions
        summary += `## Active Conditions\n`;
        if (conditions?.entry && conditions.entry.length > 0) {
          for (const entry of conditions.entry) {
            const cond = entry.resource as fhirR4.Condition;
            const name =
              cond?.code?.coding?.[0]?.display ||
              cond?.code?.text ||
              "Unknown condition";
            const onset = cond?.onsetDateTime || cond?.recordedDate || "";
            summary += `- ${name}${onset ? ` (onset: ${onset})` : ""}\n`;
          }
        } else {
          summary += `- No active conditions on record\n`;
        }
        summary += `\n`;

        // Active Medications
        summary += `## Active Medications\n`;
        if (medications?.entry && medications.entry.length > 0) {
          for (const entry of medications.entry) {
            const med = entry.resource as fhirR4.MedicationRequest;
            const name =
              med?.medicationCodeableConcept?.coding?.[0]?.display ||
              med?.medicationCodeableConcept?.text ||
              "Unknown medication";
            const dosage = med?.dosageInstruction?.[0]?.text || "";
            summary += `- ${name}${dosage ? ` — ${dosage}` : ""}\n`;
          }
        } else {
          summary += `- No active medications on record\n`;
        }
        summary += `\n`;

        // Allergies
        summary += `## Allergies\n`;
        if (allergies?.entry && allergies.entry.length > 0) {
          for (const entry of allergies.entry) {
            const allergy = entry.resource as fhirR4.AllergyIntolerance;
            const substance =
              allergy?.code?.coding?.[0]?.display ||
              allergy?.code?.text ||
              "Unknown allergen";
            const reaction =
              allergy?.reaction?.[0]?.manifestation?.[0]?.coding?.[0]
                ?.display || "";
            const severity = allergy?.criticality || "";
            summary += `- **${substance}**${reaction ? ` → ${reaction}` : ""}${severity ? ` (${severity})` : ""}\n`;
          }
        } else {
          summary += `- No known allergies (NKA)\n`;
        }
        summary += `\n`;

        // Recent Labs
        summary += `## Recent Lab Results\n`;
        if (recentLabs?.entry && recentLabs.entry.length > 0) {
          for (const entry of recentLabs.entry) {
            const obs = entry.resource as fhirR4.Observation;
            const name =
              obs?.code?.coding?.[0]?.display ||
              obs?.code?.text ||
              "Unknown test";
            const date = obs?.effectiveDateTime || "";

            let value = "";
            if (obs?.valueQuantity) {
              value = `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ""}`;
            } else if (obs?.valueString) {
              value = obs.valueString;
            }

            const interpretation =
              obs?.interpretation?.[0]?.coding?.[0]?.code || "";
            const flag =
              interpretation === "H" || interpretation === "HH"
                ? " 🔴"
                : interpretation === "L" || interpretation === "LL"
                  ? " 🔵"
                  : "";

            summary += `- ${name}: ${value}${flag} (${date})\n`;
          }
        } else {
          summary += `- No recent lab results\n`;
        }
        summary += `\n`;

        // Recent Encounters
        summary += `## Recent Encounters\n`;
        if (encounters?.entry && encounters.entry.length > 0) {
          for (const entry of encounters.entry) {
            const enc = entry.resource as fhirR4.Encounter;
            const type =
              enc?.type?.[0]?.coding?.[0]?.display ||
              enc?.type?.[0]?.text ||
              enc?.class?.display ||
              enc?.class?.code ||
              "Visit";
            const date =
              enc?.period?.start || enc?.period?.end || "Unknown date";
            const reason =
              enc?.reasonCode?.[0]?.coding?.[0]?.display ||
              enc?.reasonCode?.[0]?.text ||
              "";
            summary += `- ${type} (${date})${reason ? ` — ${reason}` : ""}\n`;
          }
        } else {
          summary += `- No recent encounters\n`;
        }
        summary += `\n`;

        summary += `---\n`;
        summary += `*Generated for clinical review. Verify all data against the source EHR before making clinical decisions.*\n`;

        return McpUtilities.createTextResponse(summary);
      },
    );
  }
}

export const GenerateVisitSummaryToolInstance = new GenerateVisitSummaryTool();

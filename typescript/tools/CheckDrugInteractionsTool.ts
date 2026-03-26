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

const KNOWN_INTERACTIONS: Record<
  string,
  { drugs: string[]; severity: string; description: string }[]
> = {
  warfarin: [
    {
      drugs: ["aspirin", "ibuprofen", "naproxen"],
      severity: "HIGH",
      description: "Increased bleeding risk with concurrent NSAID use",
    },
    {
      drugs: ["amiodarone"],
      severity: "HIGH",
      description:
        "Amiodarone inhibits warfarin metabolism, significantly increasing INR",
    },
    {
      drugs: ["metronidazole", "fluconazole"],
      severity: "MODERATE",
      description: "Antifungals/antibiotics may potentiate anticoagulant effect",
    },
  ],
  metformin: [
    {
      drugs: ["contrast dye", "iodinated contrast"],
      severity: "HIGH",
      description:
        "Risk of lactic acidosis; hold metformin 48h before/after contrast",
    },
    {
      drugs: ["alcohol", "ethanol"],
      severity: "MODERATE",
      description: "Increased risk of hypoglycemia and lactic acidosis",
    },
  ],
  lisinopril: [
    {
      drugs: ["spironolactone", "potassium"],
      severity: "HIGH",
      description: "Risk of hyperkalemia with concurrent potassium-sparing agents",
    },
    {
      drugs: ["ibuprofen", "naproxen"],
      severity: "MODERATE",
      description: "NSAIDs may reduce antihypertensive effect and worsen renal function",
    },
  ],
  simvastatin: [
    {
      drugs: ["amiodarone", "amlodipine"],
      severity: "MODERATE",
      description: "Increased risk of myopathy/rhabdomyolysis at higher statin doses",
    },
    {
      drugs: ["clarithromycin", "erythromycin"],
      severity: "HIGH",
      description: "Macrolide antibiotics significantly increase statin levels",
    },
  ],
  ssri: [
    {
      drugs: ["tramadol", "triptans", "MAOIs"],
      severity: "HIGH",
      description: "Risk of serotonin syndrome with serotonergic agents",
    },
    {
      drugs: ["warfarin", "aspirin"],
      severity: "MODERATE",
      description: "SSRIs increase bleeding risk with anticoagulants/antiplatelets",
    },
  ],
};

class CheckDrugInteractionsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "CheckDrugInteractions",
      {
        description:
          "Retrieves a patient's active medications from FHIR and checks for " +
          "known drug-drug interactions. Returns a risk-ranked list of potential " +
          "interactions with severity levels and clinical recommendations.",
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

        const bundle = await FhirClientInstance.search(
          req,
          "MedicationRequest",
          [`patient=${patientId}`, `status=active`, `_count=50`],
        );

        if (!bundle || !bundle.entry || bundle.entry.length === 0) {
          return McpUtilities.createTextResponse(
            `No active medications found for patient ${patientId}.`,
          );
        }

        const medications: string[] = [];
        for (const entry of bundle.entry) {
          const medReq = entry.resource as fhirR4.MedicationRequest;
          if (!medReq) continue;

          const name =
            medReq.medicationCodeableConcept?.coding?.[0]?.display ||
            medReq.medicationCodeableConcept?.text ||
            "Unknown medication";
          medications.push(name.toLowerCase());
        }

        const interactions: {
          drug1: string;
          drug2: string;
          severity: string;
          description: string;
        }[] = [];

        for (const med of medications) {
          for (const [drugKey, interactionList] of Object.entries(
            KNOWN_INTERACTIONS,
          )) {
            if (!med.includes(drugKey)) continue;

            for (const interaction of interactionList) {
              for (const interactingDrug of interaction.drugs) {
                const found = medications.find(
                  (m) => m !== med && m.includes(interactingDrug),
                );
                if (found) {
                  const alreadyFound = interactions.some(
                    (i) =>
                      (i.drug1 === med && i.drug2 === found) ||
                      (i.drug1 === found && i.drug2 === med),
                  );
                  if (!alreadyFound) {
                    interactions.push({
                      drug1: med,
                      drug2: found,
                      severity: interaction.severity,
                      description: interaction.description,
                    });
                  }
                }
              }
            }
          }
        }

        let summary = `## Drug Interaction Check for Patient ${patientId}\n\n`;
        summary += `**Active Medications (${medications.length}):**\n`;
        for (const med of medications) {
          summary += `- ${med}\n`;
        }
        summary += `\n`;

        if (interactions.length === 0) {
          summary += `### ✅ No known interactions detected\n`;
          summary +=
            "Note: This check covers common interactions only. Always consult a clinical pharmacist for comprehensive review.\n";
        } else {
          const high = interactions.filter((i) => i.severity === "HIGH");
          const moderate = interactions.filter((i) => i.severity === "MODERATE");

          summary += `### ⚠️ ${interactions.length} Potential Interaction(s) Found\n\n`;

          if (high.length > 0) {
            summary += `#### 🔴 HIGH Severity (${high.length})\n`;
            for (const i of high) {
              summary += `- **${i.drug1}** ↔ **${i.drug2}**: ${i.description}\n`;
            }
            summary += `\n`;
          }

          if (moderate.length > 0) {
            summary += `#### 🟡 MODERATE Severity (${moderate.length})\n`;
            for (const i of moderate) {
              summary += `- **${i.drug1}** ↔ **${i.drug2}**: ${i.description}\n`;
            }
            summary += `\n`;
          }

          summary +=
            "*Recommendation: Review flagged interactions with a clinical pharmacist before making prescribing decisions.*\n";
        }

        // AI Pharmacological Analysis via Bedrock Claude
        try {
          const patientData = await FhirClientInstance.read<fhirR4.Patient>(
            req,
            `Patient/${patientId}`,
          );
          const age = patientData?.birthDate
            ? Math.floor(
                (Date.now() - new Date(patientData.birthDate).getTime()) /
                  (365.25 * 24 * 60 * 60 * 1000),
              )
            : "unknown";
          const gender = patientData?.gender || "unknown";

          const aiAnalysis = await invokeBedrockClaude(
            "You are a clinical pharmacist specializing in drug safety. Analyze the following medication list " +
              "and any detected interactions in the context of this specific patient. Consider: " +
              "1) Patient-specific risk factors (age, gender) that may affect drug metabolism, " +
              "2) Additional interactions not in the rule-based check that an AI can identify, " +
              "3) Dosing considerations and monitoring recommendations. " +
              "Be concise but clinically actionable. " +
              "IMPORTANT: This is for clinical decision support — always recommend pharmacist verification.",
            `Patient: Age ${age}, Gender ${gender}\nActive medications: ${medications.join(", ")}\nRule-based interactions found: ${interactions.length > 0 ? interactions.map((i) => `${i.drug1} ↔ ${i.drug2}: ${i.description}`).join("; ") : "None"}`,
          );
          summary += `\n### 🤖 AI Pharmacological Analysis (Powered by Amazon Bedrock)\n${aiAnalysis}`;
        } catch (error) {
          summary += `\n*AI pharmacological analysis unavailable.*`;
        }

        return McpUtilities.createTextResponse(summary);
      },
    );
  }
}

export const CheckDrugInteractionsToolInstance =
  new CheckDrugInteractionsTool();

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

class AssessPAReadinessTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "AssessPAReadiness",
      {
        description:
          "Assesses whether a patient's medical record contains sufficient evidence " +
          "to support a Prior Authorization request. Predicts denial risk, identifies " +
          "missing documentation, and provides specific remediation steps. " +
          "This is the 'denial prediction and proactive repair' tool — catching " +
          "problems BEFORE submission saves 13+ hours/week of back-and-forth. " +
          "Powered by Amazon Bedrock Claude.",
        inputSchema: {
          patientId: z
            .string()
            .describe("The id of the patient. Optional if patient context already exists.")
            .optional(),
          serviceDescription: z
            .string()
            .describe(
              "The service or procedure requiring PA (e.g., 'Cardiac catheterization', 'Humira 40mg biweekly').",
            ),
          payerName: z
            .string()
            .describe(
              "Name of the insurance payer (e.g., 'Aetna', 'UnitedHealthcare', 'Medicare'). " +
              "Used to contextualize policy requirements.",
            )
            .optional(),
        },
      },
      async ({ patientId, serviceDescription, payerName }) => {
        if (!patientId) {
          patientId = NullUtilities.getOrThrow(
            FhirUtilities.getPatientIdIfContextExists(req),
          );
        }

        const payer = payerName || "General commercial payer";

        // Parallel FHIR data retrieval
        const [patient, conditions, observations, medications, procedures, encounters, allergies] =
          await Promise.all([
            FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`),
            FhirClientInstance.search(req, "Condition", [
              `patient=${patientId}`,
              `clinical-status=active`,
              `_count=30`,
            ]),
            FhirClientInstance.search(req, "Observation", [
              `patient=${patientId}`,
              `category=laboratory`,
              `_sort=-date`,
              `_count=20`,
            ]),
            FhirClientInstance.search(req, "MedicationRequest", [
              `patient=${patientId}`,
              `status=active`,
              `_count=30`,
            ]),
            FhirClientInstance.search(req, "Procedure", [
              `patient=${patientId}`,
              `_sort=-date`,
              `_count=10`,
            ]),
            FhirClientInstance.search(req, "Encounter", [
              `patient=${patientId}`,
              `_sort=-date`,
              `_count=10`,
            ]),
            FhirClientInstance.search(req, "AllergyIntolerance", [
              `patient=${patientId}`,
              `clinical-status=active`,
              `_count=10`,
            ]),
          ]);

        // Build clinical summary
        const age = patient?.birthDate
          ? Math.floor(
              (Date.now() - new Date(patient.birthDate).getTime()) /
                (365.25 * 24 * 60 * 60 * 1000),
            )
          : "unknown";
        const gender = patient?.gender || "unknown";

        const condList = (conditions?.entry || []).map((e) => {
          const c = e.resource as fhirR4.Condition;
          return c?.code?.coding?.[0]?.display || c?.code?.text || "Unknown";
        });

        const labList = (observations?.entry || []).map((e) => {
          const obs = e.resource as fhirR4.Observation;
          const name = obs?.code?.coding?.[0]?.display || obs?.code?.text || "Unknown";
          const date = obs?.effectiveDateTime || "no date";
          let value = "";
          if (obs?.valueQuantity) {
            value = `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ""}`;
          } else if (obs?.valueString) {
            value = obs.valueString;
          }
          return `${name}: ${value} (${date})`;
        });

        const medList = (medications?.entry || []).map((e) => {
          const med = e.resource as fhirR4.MedicationRequest;
          return (
            med?.medicationCodeableConcept?.coding?.[0]?.display ||
            med?.medicationCodeableConcept?.text ||
            "Unknown"
          );
        });

        const procList = (procedures?.entry || []).map((e) => {
          const proc = e.resource as fhirR4.Procedure;
          const name = proc?.code?.coding?.[0]?.display || proc?.code?.text || "Unknown";
          const date = proc?.performedDateTime || "no date";
          return `${name} (${date})`;
        });

        const encList = (encounters?.entry || []).map((e) => {
          const enc = e.resource as fhirR4.Encounter;
          const type =
            enc?.type?.[0]?.coding?.[0]?.display ||
            enc?.class?.display ||
            enc?.class?.code ||
            "Visit";
          const date = enc?.period?.start || "no date";
          const reason = enc?.reasonCode?.[0]?.coding?.[0]?.display || "";
          return `${type} (${date})${reason ? ` — ${reason}` : ""}`;
        });

        const allergyList = (allergies?.entry || []).map((e) => {
          const a = e.resource as fhirR4.AllergyIntolerance;
          return a?.code?.coding?.[0]?.display || a?.code?.text || "Unknown";
        });

        const clinicalSummary =
          `Patient: Age ${age}, ${gender}\n` +
          `Active conditions: ${condList.join("; ") || "None"}\n` +
          `Recent labs: ${labList.join("; ") || "None"}\n` +
          `Active medications: ${medList.join("; ") || "None"}\n` +
          `Recent procedures: ${procList.join("; ") || "None"}\n` +
          `Recent encounters: ${encList.join("; ") || "None"}\n` +
          `Allergies: ${allergyList.join("; ") || "NKDA"}`;

        // AI Readiness Assessment
        try {
          const assessment = await invokeBedrockClaude(
            `You are a Prior Authorization readiness assessor with expertise in US payer policies, CMS National Coverage Determinations (NCDs), Local Coverage Determinations (LCDs), and the Da Vinci Prior Authorization Support (PAS) framework.

Your task is to evaluate whether this patient's medical record is READY for a Prior Authorization submission, or if critical evidence is missing.

## Output Format

### READINESS SCORE
Assign one of:
- **✅ READY** — Sufficient evidence exists. High probability of approval.
- **⚠️ NEEDS WORK** — Some evidence gaps. Fixable before submission.
- **🔴 HIGH RISK** — Major evidence gaps. Likely denial if submitted now.

### DENIAL RISK ANALYSIS
For each potential denial reason, explain:
1. What specific evidence is missing or weak
2. Why a payer medical reviewer would flag this
3. The specific CMS/payer policy reference (if applicable)

### MISSING DOCUMENTATION CHECKLIST
List each missing item as a checkbox:
- [ ] Missing item description — why it's needed — how to obtain it

### REMEDIATION PLAN
For each gap, provide:
1. Specific action the clinical team should take
2. Estimated time to complete
3. Priority (Critical / Important / Nice-to-have)

### STRENGTHS
What evidence IS strong in this record that supports approval.

Be specific about dates, values, and clinical context. Generic advice is not helpful.
Reference CMS-0057-F transparency requirements where relevant.
IMPORTANT: AI-generated assessment for synthetic/de-identified data only. Must be verified by authorized clinical staff.`,
            `SERVICE REQUIRING PRIOR AUTHORIZATION: ${serviceDescription}\nPAYER: ${payer}\n\nPATIENT CLINICAL DATA:\n${clinicalSummary}`,
            2000,
          );

          return McpUtilities.createTextResponse(
            `# PA Readiness Assessment — Patient ${patientId}\n\n` +
              `**Service:** ${serviceDescription}\n` +
              `**Payer:** ${payer}\n\n` +
              `---\n\n${assessment}\n\n---\n` +
              `*Generated by PA Guardian (Amazon Bedrock Claude). This assessment is for clinical decision support only. Verify against payer-specific policies before submission.*`,
          );
        } catch {
          return McpUtilities.createTextResponse(
            `# PA Readiness — Manual Review Required\n\n` +
              `**Service:** ${serviceDescription}\n**Payer:** ${payer}\n\n` +
              `Clinical data retrieved but AI assessment unavailable. Please review:\n${clinicalSummary}`,
          );
        }
      },
    );
  }
}

export const AssessPAReadinessToolInstance = new AssessPAReadinessTool();

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

class ExtractPAEvidenceTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "ExtractPAEvidence",
      {
        description:
          "Extracts and organizes clinical evidence from a patient's FHIR records " +
          "to support a Prior Authorization request. Retrieves diagnoses, labs, " +
          "procedures, encounters, and medications, then uses AI to assemble a " +
          "structured evidence package that aligns with payer requirements. " +
          "Powered by Amazon Bedrock Claude.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The id of the patient. Optional if patient context already exists.",
            )
            .optional(),
          serviceDescription: z
            .string()
            .describe(
              "Description of the service or procedure requiring prior authorization " +
              "(e.g., 'Cardiac catheterization', 'MRI lumbar spine', 'Humira for rheumatoid arthritis').",
            ),
          diagnosisCode: z
            .string()
            .describe(
              "Primary ICD-10 diagnosis code supporting the request (e.g., 'I48.0' for atrial fibrillation). Optional.",
            )
            .optional(),
        },
      },
      async ({ patientId, serviceDescription, diagnosisCode }) => {
        if (!patientId) {
          patientId = NullUtilities.getOrThrow(
            FhirUtilities.getPatientIdIfContextExists(req),
          );
        }

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

        // Format raw FHIR data into readable clinical summary
        const sections: string[] = [];

        // Patient demographics
        if (patient) {
          const name = patient.name?.[0];
          const fullName = name
            ? `${name.given?.join(" ") || ""} ${name.family || ""}`.trim()
            : "Unknown";
          const age = patient.birthDate
            ? Math.floor(
                (Date.now() - new Date(patient.birthDate).getTime()) /
                  (365.25 * 24 * 60 * 60 * 1000),
              )
            : "unknown";
          sections.push(
            `PATIENT: ${fullName}, Age ${age}, ${patient.gender || "unknown"}, DOB ${patient.birthDate || "unknown"}`,
          );
        }

        // Active conditions
        const condList: string[] = [];
        if (conditions?.entry) {
          for (const e of conditions.entry) {
            const c = e.resource as fhirR4.Condition;
            const name = c?.code?.coding?.[0]?.display || c?.code?.text || "Unknown";
            const code = c?.code?.coding?.[0]?.code || "";
            const onset = c?.onsetDateTime || c?.recordedDate || "";
            condList.push(`${name}${code ? ` (${code})` : ""}${onset ? ` onset: ${onset}` : ""}`);
          }
        }
        sections.push(`ACTIVE CONDITIONS (${condList.length}):\n${condList.map((c) => `- ${c}`).join("\n") || "- None on record"}`);

        // Recent labs
        const labList: string[] = [];
        if (observations?.entry) {
          for (const e of observations.entry) {
            const obs = e.resource as fhirR4.Observation;
            const name = obs?.code?.coding?.[0]?.display || obs?.code?.text || "Unknown";
            const date = obs?.effectiveDateTime || "";
            let value = "";
            if (obs?.valueQuantity) {
              value = `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ""}`;
            } else if (obs?.valueString) {
              value = obs.valueString;
            }
            labList.push(`${name}: ${value} (${date})`);
          }
        }
        sections.push(`RECENT LAB RESULTS (${labList.length}):\n${labList.map((l) => `- ${l}`).join("\n") || "- None available"}`);

        // Active medications
        const medList: string[] = [];
        if (medications?.entry) {
          for (const e of medications.entry) {
            const med = e.resource as fhirR4.MedicationRequest;
            const name =
              med?.medicationCodeableConcept?.coding?.[0]?.display ||
              med?.medicationCodeableConcept?.text ||
              "Unknown";
            const dosage = med?.dosageInstruction?.[0]?.text || "";
            medList.push(`${name}${dosage ? ` — ${dosage}` : ""}`);
          }
        }
        sections.push(`ACTIVE MEDICATIONS (${medList.length}):\n${medList.map((m) => `- ${m}`).join("\n") || "- None on record"}`);

        // Recent procedures
        const procList: string[] = [];
        if (procedures?.entry) {
          for (const e of procedures.entry) {
            const proc = e.resource as fhirR4.Procedure;
            const name = proc?.code?.coding?.[0]?.display || proc?.code?.text || "Unknown";
            const date = proc?.performedDateTime || "";
            procList.push(`${name} (${date})`);
          }
        }
        sections.push(`RECENT PROCEDURES (${procList.length}):\n${procList.map((p) => `- ${p}`).join("\n") || "- None on record"}`);

        // Recent encounters
        const encList: string[] = [];
        if (encounters?.entry) {
          for (const e of encounters.entry) {
            const enc = e.resource as fhirR4.Encounter;
            const type =
              enc?.type?.[0]?.coding?.[0]?.display ||
              enc?.class?.display ||
              enc?.class?.code ||
              "Visit";
            const date = enc?.period?.start || "";
            const reason = enc?.reasonCode?.[0]?.coding?.[0]?.display || enc?.reasonCode?.[0]?.text || "";
            encList.push(`${type} (${date})${reason ? ` — ${reason}` : ""}`);
          }
        }
        sections.push(`RECENT ENCOUNTERS (${encList.length}):\n${encList.map((e) => `- ${e}`).join("\n") || "- None on record"}`);

        // Allergies
        const allergyList: string[] = [];
        if (allergies?.entry) {
          for (const e of allergies.entry) {
            const a = e.resource as fhirR4.AllergyIntolerance;
            const substance = a?.code?.coding?.[0]?.display || a?.code?.text || "Unknown";
            allergyList.push(substance);
          }
        }
        sections.push(`ALLERGIES: ${allergyList.length > 0 ? allergyList.join(", ") : "No Known Drug Allergies (NKDA)"}`);

        const clinicalData = sections.join("\n\n");

        // AI Evidence Extraction via Bedrock Claude
        try {
          const evidencePackage = await invokeBedrockClaude(
            `You are a Prior Authorization specialist with deep knowledge of US healthcare payer requirements, CMS guidelines, and the Da Vinci Prior Authorization Support (PAS) implementation guide.

Your task is to extract and organize clinical evidence from the patient's medical record to support a Prior Authorization request.

## Output Format

Generate a structured **PA Evidence Package** with these sections:

### 1. Service Requested
- Service/procedure description
- Relevant CPT/HCPCS codes (if inferable)
- Primary and secondary diagnosis codes (ICD-10)

### 2. Clinical Justification
- Why this service is medically necessary for THIS specific patient
- How the patient's conditions, labs, and history support the need
- Prior treatments attempted and their outcomes (step therapy compliance)

### 3. Supporting Evidence Summary
- Key lab values that support medical necessity (with dates)
- Relevant diagnoses and their clinical progression
- Prior procedures and encounters demonstrating treatment history
- Current medication regimen showing treatment complexity

### 4. Risk Assessment
- What happens if this service is denied or delayed
- Patient-specific risk factors that increase urgency

### 5. Payer-Ready Summary
- A concise 2-3 paragraph narrative suitable for inclusion in a PA submission form

Be specific, cite actual values from the patient data, and use clinical terminology appropriate for payer medical reviewers.
IMPORTANT: This is AI-generated clinical decision support for synthetic/de-identified data only. All outputs must be verified by a licensed clinician before submission.`,
            `SERVICE REQUIRING PRIOR AUTHORIZATION: ${serviceDescription}${diagnosisCode ? `\nPRIMARY DIAGNOSIS CODE: ${diagnosisCode}` : ""}\n\nPATIENT CLINICAL DATA:\n${clinicalData}`,
            2000,
          );

          return McpUtilities.createTextResponse(
            `# PA Evidence Package — Patient ${patientId}\n\n` +
              `**Service Requested:** ${serviceDescription}\n` +
              `${diagnosisCode ? `**Primary Diagnosis:** ${diagnosisCode}\n` : ""}` +
              `\n---\n\n${evidencePackage}\n\n---\n` +
              `*Generated by PA Guardian (Amazon Bedrock Claude). Verify all clinical data against source EHR before submission.*`,
          );
        } catch (error) {
          return McpUtilities.createTextResponse(
            `# PA Evidence — Raw Clinical Data\n\n${clinicalData}\n\n*AI analysis unavailable. Please review raw data manually.*`,
          );
        }
      },
    );
  }
}

export const ExtractPAEvidenceToolInstance = new ExtractPAEvidenceTool();

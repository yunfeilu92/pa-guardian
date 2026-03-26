import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { McpUtilities } from "../mcp-utilities";
import { invokeBedrockClaude } from "../bedrock-client";

class GeneratePADocumentsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GeneratePADocuments",
      {
        description:
          "Generates professional Prior Authorization documents using AI. " +
          "Supports three document types: Letter of Medical Necessity (LMN), " +
          "Appeal Letter (for denied requests), and PA Summary (for submission forms). " +
          "Takes clinical evidence as input and produces payer-ready documents. " +
          "Powered by Amazon Bedrock Claude.",
        inputSchema: {
          documentType: z
            .enum(["LMN", "APPEAL", "SUMMARY"])
            .describe(
              "Type of document to generate: " +
              "'LMN' = Letter of Medical Necessity, " +
              "'APPEAL' = Appeal letter for a denied PA, " +
              "'SUMMARY' = Concise summary for PA submission form.",
            ),
          serviceDescription: z
            .string()
            .describe("The service or procedure requiring PA."),
          clinicalEvidence: z
            .string()
            .describe(
              "Clinical evidence supporting the request. This should be the output " +
              "from ExtractPAEvidence or a manual summary of the patient's clinical data.",
            ),
          patientName: z
            .string()
            .describe("Patient's full name for the document header.")
            .optional(),
          patientDOB: z
            .string()
            .describe("Patient's date of birth (YYYY-MM-DD).")
            .optional(),
          providerName: z
            .string()
            .describe("Ordering provider's name.")
            .optional(),
          denialReason: z
            .string()
            .describe(
              "Reason for denial (required for APPEAL type). " +
              "e.g., 'Insufficient documentation of medical necessity' or " +
              "'Step therapy requirement not met'.",
            )
            .optional(),
          payerName: z
            .string()
            .describe("Insurance payer name.")
            .optional(),
        },
      },
      async ({
        documentType,
        serviceDescription,
        clinicalEvidence,
        patientName,
        patientDOB,
        providerName,
        denialReason,
        payerName,
      }) => {
        const patientInfo = patientName
          ? `Patient: ${patientName}${patientDOB ? `, DOB: ${patientDOB}` : ""}`
          : "Patient: [See chart]";
        const provider = providerName || "[Ordering Provider]";
        const payer = payerName || "[Insurance Payer]";

        const prompts: Record<string, { system: string; user: string }> = {
          LMN: {
            system: `You are a physician writing a Letter of Medical Necessity (LMN) for a Prior Authorization request. You have extensive experience with US payer requirements and clinical documentation.

Write a professional, compelling LMN that:
1. Follows standard medical letter format (date, addresses, RE line, body, signature block)
2. Clearly states the medical necessity using evidence-based clinical reasoning
3. References relevant clinical guidelines (ACC/AHA, NCCN, ACR, etc.)
4. Cites specific patient data (lab values, imaging findings, failed treatments)
5. Addresses common denial reasons proactively
6. Uses professional medical terminology appropriate for a payer medical director
7. Includes a clear request and urgency statement

The letter should be 1-2 pages in length. Do NOT fabricate clinical data — use only what is provided.
IMPORTANT: This is AI-generated for synthetic/de-identified data. Must be reviewed and signed by the ordering physician.`,
            user:
              `Generate a Letter of Medical Necessity for:\n\n` +
              `SERVICE: ${serviceDescription}\n` +
              `${patientInfo}\n` +
              `ORDERING PROVIDER: ${provider}\n` +
              `PAYER: ${payer}\n\n` +
              `CLINICAL EVIDENCE:\n${clinicalEvidence}`,
          },
          APPEAL: {
            system: `You are a physician writing an appeal letter for a denied Prior Authorization request. You specialize in overturning PA denials through rigorous clinical argumentation.

Write a professional appeal letter that:
1. Formally references the denial and its stated reason
2. Systematically refutes each denial reason with clinical evidence
3. References CMS guidelines, NCDs/LCDs, and relevant clinical practice guidelines
4. Highlights patient-specific factors that make this service medically necessary
5. Notes the potential harm of denial (delayed treatment, disease progression, etc.)
6. Requests a peer-to-peer review if appropriate
7. Cites the CMS-0057-F transparency requirements for denial justification
8. Maintains a firm but professional tone

The appeal should directly address the specific denial reason provided.
IMPORTANT: AI-generated for synthetic/de-identified data. Must be reviewed and signed by the ordering physician.`,
            user:
              `Generate an Appeal Letter for a denied Prior Authorization:\n\n` +
              `SERVICE DENIED: ${serviceDescription}\n` +
              `DENIAL REASON: ${denialReason || "Not specified — address common denial reasons"}\n` +
              `${patientInfo}\n` +
              `ORDERING PROVIDER: ${provider}\n` +
              `PAYER: ${payer}\n\n` +
              `CLINICAL EVIDENCE:\n${clinicalEvidence}`,
          },
          SUMMARY: {
            system: `You are a clinical documentation specialist preparing a concise Prior Authorization summary for a payer submission form.

Write a clear, structured summary (300-500 words) that:
1. States the clinical indication and medical necessity in 2-3 sentences
2. Lists supporting diagnoses with ICD-10 codes
3. Summarizes relevant clinical findings (labs, imaging, exam)
4. Documents prior treatments attempted (step therapy compliance)
5. States the expected outcome and treatment plan
6. Notes urgency level and consequences of delay

Use bullet points for clarity. This goes into the "Clinical Information" section of a PA form.
IMPORTANT: AI-generated for synthetic/de-identified data. Must be verified by clinical staff.`,
            user:
              `Generate a PA Submission Summary for:\n\n` +
              `SERVICE: ${serviceDescription}\n` +
              `${patientInfo}\n` +
              `PAYER: ${payer}\n\n` +
              `CLINICAL EVIDENCE:\n${clinicalEvidence}`,
          },
        };

        const prompt = prompts[documentType];
        if (!prompt) {
          return McpUtilities.createTextResponse(
            `Unknown document type: ${documentType}. Use LMN, APPEAL, or SUMMARY.`,
            { isError: true },
          );
        }

        const docTypeLabels: Record<string, string> = {
          LMN: "Letter of Medical Necessity",
          APPEAL: "Appeal Letter",
          SUMMARY: "PA Submission Summary",
        };

        try {
          const document = await invokeBedrockClaude(
            prompt.system,
            prompt.user,
            2500,
          );

          return McpUtilities.createTextResponse(
            `# ${docTypeLabels[documentType]}\n\n` +
              `**Service:** ${serviceDescription}\n` +
              `**${patientInfo}**\n` +
              `**Payer:** ${payer}\n\n` +
              `---\n\n${document}\n\n---\n` +
              `*Generated by PA Guardian (Amazon Bedrock Claude). This document must be reviewed, edited, and signed by the ordering physician before submission to the payer.*`,
          );
        } catch {
          return McpUtilities.createTextResponse(
            `Failed to generate ${docTypeLabels[documentType]}. AI service unavailable. Please draft manually using the provided clinical evidence.`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const GeneratePADocumentsToolInstance = new GeneratePADocumentsTool();

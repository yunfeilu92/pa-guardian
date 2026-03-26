import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const region = process.env["AWS_REGION"] || "us-east-1";
const modelId =
  process.env["BEDROCK_MODEL_ID"] ||
  "anthropic.claude-3-haiku-20240307-v1:0";

const client = new BedrockRuntimeClient({ region });

export async function invokeBedrockClaude(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 1024,
): Promise<string> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(body),
  });

  const response = await client.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.content[0].text;
}

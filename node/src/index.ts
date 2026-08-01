import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config({ path: "../.env" });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello, OpenAI" }],
  });
  console.log(response.choices[0].message.content);
}

main();

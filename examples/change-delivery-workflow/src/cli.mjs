import { readFile, writeFile } from "node:fs/promises";

export async function run(argv) {
  const inputIndex = argv.indexOf("--input");
  const outputIndex = argv.indexOf("--output");

  if (inputIndex === -1 || outputIndex === -1) {
    throw new Error("Usage: example --input <path> --output <path>");
  }

  const inputPath = argv[inputIndex + 1];
  const outputPath = argv[outputIndex + 1];
  const source = await readFile(inputPath, "utf8");
  const result = source.toUpperCase();

  await writeFile(outputPath, result, "utf8");
  return { inputPath, outputPath, bytes: Buffer.byteLength(result) };
}

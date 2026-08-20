import { promises as fs } from "node:fs";


export async function loadReviewer(reviewerFile, maxChars = 6000) {
  if (!reviewerFile) return null;
  let criteria;
  try {
    criteria = (await fs.readFile(reviewerFile, "utf8")).trim();
  } catch (error) {
    throw new Error(`无法读取 Agent 审阅标准 ${reviewerFile}: ${error.message}`);
  }
  if (!criteria) {
    throw new Error(
      `Agent 审阅标准 ${reviewerFile} 为空；请填写 criteria，`
      + "或在 config.yaml 中设置 review.enabled: false。",
    );
  }
  if (criteria.length > maxChars) {
    throw new Error(
      `Agent 审阅标准超过 ${maxChars} 字符，请拆分或精简 ${reviewerFile}。`,
    );
  }
  return { path: reviewerFile, criteria };
}

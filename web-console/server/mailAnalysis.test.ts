import { describe, expect, it } from "vitest";
import { analyzeEmail, classifyText, parseTrainingDataset, trainNaiveBayes } from "./mailAnalysis";

describe("mail analysis core", () => {
  it("parses a message and detects archive plus URL confusion", async () => {
    const raw = Buffer.from("From: sender@example.test\r\nTo: analyst@example.test\r\nSubject: Review\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nOpen https://trusted.example@198.51.100.7/login\r\n--x\r\nContent-Type: application/zip; name=review.zip\r\nContent-Disposition: attachment; filename=review.zip\r\nContent-Transfer-Encoding: base64\r\n\r\nUEsDBAoAAAAAA\r\n--x--");
    const task = await analyzeEmail({ filename: "review.eml", raw });
    expect(task.status).toBe("completed");
    expect(task.result.analysis.rules.matches.map(item => item.rule_id)).toEqual(expect.arrayContaining(["ATTACHMENT_ARCHIVE", "PHISHING_AT_SIGN_URL", "PHISHING_IP_URL"]));
    expect(task.result.analysis.external_engines[0]?.status).toBe("disabled");
  });

  it("trains and applies a ham/spam model", () => {
    const rows = parseTrainingDataset(Array.from({ length: 5 }, (_, index) => `{"label":"ham","text":"normal internal report ${index}"}`).concat(Array.from({ length: 5 }, (_, index) => `{"label":"spam","text":"urgent verify password now ${index}"}`)).join("\n"));
    const prediction = classifyText("urgent password verification", trainNaiveBayes(rows));
    expect(prediction.label).toBe("spam");
    expect(prediction.spamProbability).toBeGreaterThan(0.5);
  });
});

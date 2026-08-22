import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const INVALID_PDF_PASSWORD = "INVALID_PDF_PASSWORD";
export const PDF_DECRYPTION_FAILED = "PDF_DECRYPTION_FAILED";
export const PDF_DECRYPTOR_UNAVAILABLE = "PDF_DECRYPTOR_UNAVAILABLE";
export const PDF_PASSWORD_REQUIRED = "PDF_PASSWORD_REQUIRED";

/**
 * Helper to execute qpdf CLI arguments via spawn, handling exit codes and missing binaries.
 */
function runQpdf(args: string[]): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("qpdf", args, { stdio: "ignore" });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(PDF_DECRYPTOR_UNAVAILABLE));
      } else {
        reject(new Error(PDF_DECRYPTION_FAILED));
      }
    });

    child.on("close", (code) => {
      resolve({ exitCode: code });
    });
  });
}

/**
 * Decrypts a base64-encoded PDF using qpdf.
 *
 * Handles:
 * - Unencrypted PDFs (returns original buffer unmodified)
 * - Numeric passwords with leading zeros (passed strictly as string)
 * - Protected PDFs with missing or invalid passwords
 * - Missing qpdf binary detection (PDF_DECRYPTOR_UNAVAILABLE)
 */
export async function decryptPdf(
  base64Pdf: string,
  password?: string
): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pdf-decrypt-"));
  const tempIn = path.join(tempDir, "input.pdf");
  const tempOut = path.join(tempDir, "output.pdf");

  try {
    const inputBuffer = Buffer.from(base64Pdf, "base64");
    await writeFile(tempIn, inputBuffer);

    // 1. Password validation check using `--requires-password`
    // qpdf exit codes for --requires-password:
    // - Code 2: File is unencrypted (does not require password)
    // - Code 3: Password supplied is valid
    // - Code 0: File requires a password (password missing or incorrect)
    const checkArgs = password !== undefined
      ? ["--requires-password", `--password=${password}`, tempIn]
      : ["--requires-password", tempIn];

    const checkResult = await runQpdf(checkArgs);

    // Case A: Unencrypted PDF
    if (checkResult.exitCode === 2) {
      return base64Pdf;
    }

    // Case B: Password was not supplied for a protected PDF
    if (password === undefined) {
      if (checkResult.exitCode === 0) {
        throw new Error(PDF_PASSWORD_REQUIRED);
      }
      throw new Error(PDF_DECRYPTION_FAILED);
    }

    // Case C: Supplied password was rejected
    if (checkResult.exitCode === 0) {
      throw new Error(INVALID_PDF_PASSWORD);
    }

    // Case D: Any unexpected exit code during validation
    if (checkResult.exitCode !== 3) {
      throw new Error(PDF_DECRYPTION_FAILED);
    }

    // 2. Perform actual decryption
    const decryptArgs = [
      `--password=${password}`,
      "--decrypt",
      tempIn,
      tempOut,
    ];

    const decryptResult = await runQpdf(decryptArgs);

    if (decryptResult.exitCode !== 0) {
      throw new Error(PDF_DECRYPTION_FAILED);
    }

    const decryptedBuffer = await readFile(tempOut);
    return decryptedBuffer.toString("base64");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
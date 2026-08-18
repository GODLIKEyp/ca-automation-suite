import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

export async function decryptPdf(
  pdfBase64: string,
  password?: string
): Promise<string> {
  if (!pdfBase64) {
    throw new Error("PDF data is required.");
  }

  const tempDir = await mkdtemp(
    path.join(tmpdir(), "ca-bank-statement-")
  );

  const inputPath = path.join(tempDir, "input.pdf");
  const outputPath = path.join(tempDir, "decrypted.pdf");

  try {
    await writeFile(
      inputPath,
      Buffer.from(pdfBase64, "base64")
    );

    // ---------------------------------------------------------
    // 1. Check whether the PDF requires a password
    // ---------------------------------------------------------
    if (!password) {
      try {
        await execFileAsync("qpdf", [
          "--requires-password",
          inputPath,
        ]);

        // Exit code 0 means a password is required.
        throw new Error("PDF_PASSWORD_REQUIRED");
      } catch (error: any) {
        // qpdf exit code 0 means password required.
        // qpdf exit code 2 means the PDF does not require a password.
        if (error?.code === 0) {
          throw new Error("PDF_PASSWORD_REQUIRED");
        }

        if (error?.code === 2) {
          // Normal, unprotected PDF.
          return pdfBase64;
        }

        throw error;
      }
    }

    // ---------------------------------------------------------
    // 2. Password supplied → decrypt
    // ---------------------------------------------------------
    try {
      await execFileAsync("qpdf", [
        `--password=${password}`,
        "--decrypt",
        inputPath,
        outputPath,
      ]);
    } catch {
      throw new Error("INVALID_PDF_PASSWORD");
    }

    // ---------------------------------------------------------
    // 3. Return decrypted PDF as base64
    // ---------------------------------------------------------
    const decryptedBuffer = await readFile(outputPath);

    return decryptedBuffer.toString("base64");
  } finally {
    // Always delete temporary files.
    await rm(tempDir, {
      recursive: true,
      force: true,
    });
  }
}
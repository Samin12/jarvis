/**
 * Run receipts — loopy-inspired auditable history of every Codex dispatch.
 * Persisted as JSONL in userData/codex-receipts.jsonl (append-only).
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import { appendFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { CodexRunReceipt } from '../../../shared/types'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function receiptsFilePath(): string {
  return join(app.getPath('userData'), 'codex-receipts.jsonl')
}

/** Append one receipt as a JSONL line. Errors are logged, never thrown (receipts must not kill a task). */
export async function appendReceipt(receipt: CodexRunReceipt): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await appendFile(receiptsFilePath(), JSON.stringify(receipt) + '\n', 'utf8')
  } catch (err) {
    console.error('[codex] failed to persist run receipt', err)
  }
}

/** Load receipt history, newest first. Missing/corrupt file -> []. Bad lines are skipped. */
export async function loadReceipts(limit = 200): Promise<CodexRunReceipt[]> {
  let raw: string
  try {
    raw = await readFile(receiptsFilePath(), 'utf8')
  } catch {
    return []
  }
  const receipts: CodexRunReceipt[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as CodexRunReceipt
      if (parsed && typeof parsed.taskId === 'string' && typeof parsed.terminal === 'string') {
        receipts.push(parsed)
      }
    } catch {
      // skip corrupt line
    }
  }
  receipts.sort((a, b) => b.finishedAt - a.finishedAt)
  return receipts.slice(0, limit)
}

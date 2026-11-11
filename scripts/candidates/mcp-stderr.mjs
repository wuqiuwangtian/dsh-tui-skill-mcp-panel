/** Upstream candidate only: bounded stderr diagnostics, never a terminal sink. */
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'

export const STDERR_LIMITS = { lineBytes: 4096, logBytes: 16384, lines: 32 }

export function drainMcpStderr(stream, report, environmentValues = []) {
  const decoder = new StringDecoder('utf8')
  const secrets = [...new Set(environmentValues.filter(value => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length)
  let pending = '', oversized = false, finished = false, emitted = 0, lines = 0, suppressed = false
  const safeReport = text => { try { report(text) } catch { /* Logging must not kill a connection. */ } }
  const emit = line => {
    if (!line && !oversized) return
    let text = oversized ? '[stderr line exceeds limit]' : stripVTControlCharacters(line)
    for (const secret of secrets) text = text.split(secret).join('[redacted]')
    text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
    const bytes = Buffer.byteLength(text)
    if (lines >= STDERR_LIMITS.lines || emitted + bytes > STDERR_LIMITS.logBytes) { suppressed = true; return }
    lines++; emitted += bytes; safeReport(text)
  }
  const consume = text => {
    for (const part of text.split(/(?<=\n)/)) {
      const complete = part.endsWith('\n'), value = complete ? part.slice(0, -1) : part
      if (!oversized) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(value) > STDERR_LIMITS.lineBytes) { pending = ''; oversized = true }
        else pending += value
      }
      if (complete) { emit(pending); pending = ''; oversized = false }
    }
  }
  const onData = chunk => consume(decoder.write(chunk))
  const finish = () => {
    if (finished) return
    finished = true; consume(decoder.end()); emit(pending)
    if (suppressed) safeReport('[additional stderr diagnostics suppressed for this connection]')
    stream.off('data', onData); stream.off('end', finish); stream.off('close', finish); stream.off('error', onError)
    stream.destroy()
  }
  const onError = () => { safeReport('[stderr stream error]'); finish() }
  stream.on('data', onData); stream.once('end', finish); stream.once('close', finish); stream.once('error', onError)
  return finish
}

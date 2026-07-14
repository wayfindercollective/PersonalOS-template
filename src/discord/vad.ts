import { EventEmitter } from 'node:events'
import { logger } from '../logger.js'

const log = logger.child({ module: 'vad' })

export interface VADOptions {
  /** RMS threshold for speech detection (0-1). Default: 0.01 */
  threshold?: number
  /** Silence duration (ms) before speech end. Default: 1500 */
  silenceMs?: number
  /** Minimum speech duration (ms) to be valid. Default: 500 */
  minSpeechMs?: number
  /** Sample rate of incoming audio. Default: 48000 */
  sampleRate?: number
}

interface VADEvents {
  speechStart: []
  speechEnd: [audioBuffer: Buffer]
  error: [error: Error]
}

/**
 * Simple energy-based Voice Activity Detection
 * Buffers audio during speech and emits when silence is detected
 */
export class VAD extends EventEmitter<VADEvents> {
  private threshold: number
  private silenceMs: number
  private minSpeechMs: number
  private sampleRate: number

  private isSpeaking = false
  private speechStartTime = 0
  private lastSpeechTime = 0
  private audioChunks: Buffer[] = []
  private silenceCheckInterval: ReturnType<typeof setInterval> | null = null

  constructor(options: VADOptions = {}) {
    super()
    this.threshold = options.threshold ?? 0.01
    this.silenceMs = options.silenceMs ?? 1500
    this.minSpeechMs = options.minSpeechMs ?? 500
    this.sampleRate = options.sampleRate ?? 48000
  }

  /**
   * Start monitoring for speech
   */
  start(): void {
    this.silenceCheckInterval = setInterval(() => {
      this.checkSilence()
    }, 100)
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval)
      this.silenceCheckInterval = null
    }
    this.reset()
  }

  /**
   * Process incoming audio chunk (signed 16-bit PCM)
   */
  processAudio(chunk: Buffer): void {
    const rms = this.calculateRMS(chunk)
    const now = Date.now()

    if (rms > this.threshold) {
      // Speech detected
      if (!this.isSpeaking) {
        this.isSpeaking = true
        this.speechStartTime = now
        this.audioChunks = []
        log.debug({ rms }, 'Speech started')
        this.emit('speechStart')
      }
      this.lastSpeechTime = now
      this.audioChunks.push(chunk)
    } else if (this.isSpeaking) {
      // Below threshold but still in speech state - keep buffering
      this.audioChunks.push(chunk)
    }
  }

  /**
   * Check if silence threshold has been reached
   */
  private checkSilence(): void {
    if (!this.isSpeaking) return

    const now = Date.now()
    const silenceDuration = now - this.lastSpeechTime
    const speechDuration = now - this.speechStartTime

    if (silenceDuration >= this.silenceMs) {
      // Silence detected - end speech
      this.isSpeaking = false

      if (speechDuration >= this.minSpeechMs && this.audioChunks.length > 0) {
        const audioBuffer = Buffer.concat(this.audioChunks)
        log.debug(
          { speechDuration, chunks: this.audioChunks.length, bytes: audioBuffer.length },
          'Speech ended'
        )
        this.emit('speechEnd', audioBuffer)
      } else {
        log.debug({ speechDuration }, 'Speech too short, discarding')
      }

      this.audioChunks = []
    }
  }

  /**
   * Calculate RMS (root mean square) of audio buffer
   * Assumes signed 16-bit PCM
   */
  private calculateRMS(buffer: Buffer): number {
    if (buffer.length < 2) return 0

    let sum = 0
    const samples = buffer.length / 2

    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768 // Normalize to -1 to 1
      sum += sample * sample
    }

    return Math.sqrt(sum / samples)
  }

  /**
   * Reset state
   */
  private reset(): void {
    this.isSpeaking = false
    this.speechStartTime = 0
    this.lastSpeechTime = 0
    this.audioChunks = []
  }

  /**
   * Check if currently detecting speech
   */
  get speaking(): boolean {
    return this.isSpeaking
  }
}

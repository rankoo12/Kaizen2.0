import type { Logger } from 'pino';
import type { IObservability } from './interfaces';
import type { Span } from '../../types';

/**
 * Phase 1 implementation of IObservability backed by pino.
 *
 * startSpan   — log-based timer; collects setAttribute calls via closure,
 *               logs everything in one structured event on end().
 *               Phase 4 will replace this body with a real OTel span —
 *               no callers change.
 *
 * increment   — emits a structured log line. Phase 4 replaces with an
 *               OTel counter instrument.
 *
 * histogram   — emits a structured log line. Phase 4 replaces with an
 *               OTel histogram instrument.
 *
 * Caller responsibility: pass in the application's pino Logger instance
 * (from Fastify's app.log in the API process, or a standalone pino
 * instance in the worker process). This avoids creating a second logger
 * and keeps all output on one stream.
 */
export class PinoObservability implements IObservability {
  constructor(private readonly logger: Logger) {}

  startSpan(name: string, attributes?: Record<string, string>): Span {
    const start = Date.now();
    // Mutable bag — setAttribute() calls accumulate here during the span's
    // lifetime and are flushed to the log in a single event on end().
    const attrs: Record<string, unknown> = { ...attributes };

    return {
      setAttribute(key: string, value: string | number | boolean): void {
        attrs[key] = value;
      },
      end: () => {
        this.logger.info({
          event: 'span_end',
          span: name,
          durationMs: Date.now() - start,
          ...attrs,
        });
      },
    };
  }

  log(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown>): void {
    // Spread data into top-level fields so logs are flat and queryable.
    // Never embed facts inside the event string itself (spec §17).
    this.logger[level]({ event, ...data });
  }

  increment(metric: string, labels?: Record<string, string>): void {
    this.logger.info({ event: 'metric_increment', metric, ...labels });
  }

  histogram(metric: string, value: number, labels?: Record<string, string>): void {
    this.logger.info({ event: 'metric_histogram', metric, value, ...labels });
  }
}

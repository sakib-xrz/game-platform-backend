import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source_paths = [
  'src/modules/greedy/greedy.services.ts',
  'src/modules/teen-patti/teen-patti.services.ts',
  'src/modules/wallet/wallet.services.ts',
  'src/workers/greedy-round.worker.ts',
  'src/workers/teen-patti-round.worker.ts',
];

const walletEventObjects = () => source_paths.flatMap((source_path) => {
  const source_text = readFileSync(source_path, 'utf8');
  const source_file = ts.createSourceFile(
    source_path,
    source_text,
    ts.ScriptTarget.Latest,
    true,
  );
  const events: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const event_type = node.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(source_file) === 'event_type',
      );
      if (
        event_type &&
        ts.isStringLiteral(event_type.initializer) &&
        event_type.initializer.text === 'wallet.balance.updated'
      ) {
        events.push(node.getText(source_file));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source_file);
  return events;
});

describe('wallet ordering contract', () => {
  it('includes a monotonic wallet version in every balance update source', () => {
    const events = walletEventObjects();
    expect(events.length).toBeGreaterThanOrEqual(7);
    for (const event of events) {
      expect(event).toMatch(/wallet_version\s*:/);
    }

    const all_events = events.join('\n');
    for (const reason of [
      'greedy_bet',
      'teen_patti_bet',
      'greedy_win',
      'teen_patti_win',
      'greedy_refund',
      'teen_patti_refund',
      'admin_adjustment',
    ]) {
      expect(all_events).toContain(`reason: '${reason}'`);
    }
  });

  it('includes ordering and request correlation in accepted-bet contracts and events', () => {
    for (const game of ['greedy', 'teen-patti']) {
      const type_source = readFileSync(
        `src/modules/${game}/${game}.types.ts`,
        'utf8',
      );
      const service_source = readFileSync(
        `src/modules/${game}/${game}.services.ts`,
        'utf8',
      );
      expect(type_source).toMatch(/wallet_version:\s*number/);
      expect(type_source).toMatch(/client_request_id:\s*string/);
      expect(service_source).toMatch(
        /client_request_id:\s*payload\.client_request_id/,
      );
      expect(service_source).toMatch(
        /event_type:\s*['"](?:greedy|teen_patti)\.bet\.accepted['"][\s\S]{0,200}payload:\s*toJsonSafe\(response\)/,
      );
    }
  });
});

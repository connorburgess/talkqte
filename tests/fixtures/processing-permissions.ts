// Fictional native replies for actual-notebook integration tests. No provider.
import {
  noteKey,
  type ExpectedScope,
  type ProcessingReview,
  type ProcessingScope,
  type ProcessingSnapshot,
} from '../../src/lib/processing';

export function fictionalPermissions(
  state: () => ProcessingSnapshot,
  send: (value: Partial<ProcessingSnapshot>) => Promise<void>,
) {
  const calls: { command: string; args: unknown }[] = [];
  const reviews = new Map<string, ProcessingReview>();
  const delays = new Set<string>();
  const releases = new Map<string, () => void>();
  const failures = new Set<string>();
  let reviewNumber = 0;
  async function boundary(value: Partial<ProcessingSnapshot>) {
    reviews.clear();
    await send({ ...value, scopeRevision: state().scopeRevision + 1 });
  }
  return {
    calls,
    commands: [
      'review_processing_scope',
      'approve_processing_scope',
      'cancel_processing_review',
      'set_processing_paused',
      'revoke_processing',
    ],
    configuration: (hosted = false): Partial<ProcessingSnapshot> => ({
      processor: {
        id: 'fictional-processor',
        revision: 1,
        name: 'Garden evaluator',
        model: 'Fictional model',
        location: hosted ? 'hosted' : 'onDevice',
        destination: hosted ? 'Example service' : '',
        dataPolicy: hosted
          ? 'Selected context leaves this device for Example service. This fictional policy does not promise immediate deletion by the service.'
          : 'Selected context is processed on this device. Approval is kept in memory for this session.',
      },
      notes: [
        {
          provider: 'granola',
          sourceId: 'garden',
          revision: 2,
          title: 'Garden launch · watering plan',
          sourceDate: '2026-11-01',
        },
        {
          provider: 'file',
          sourceId: 'garden',
          revision: 1,
          title: 'Garden launch · supplier review',
          sourceDate: '2026-11-02',
        },
      ],
    }),
    hold: (command: string) => delays.add(command),
    release: (command: string) => {
      releases.get(command)?.();
      releases.delete(command);
    },
    fail: (command: string) => failures.add(command),
    replaceSources: () =>
      boundary({
        notes: state().notes.map((note) => ({
          ...note,
          revision: note.revision + 1,
        })),
        phase: 'off',
        approved: null,
        issue: 'scopeChanged',
      }),
    async command(command: string, args: unknown) {
      calls.push({ command, args: structuredClone(args) });
      const requireScope = () => {
        const expected = (args as { expected: ExpectedScope }).expected;
        if (
          expected.session !== state().session ||
          expected.scopeRevision !== state().scopeRevision
        )
          throw 'scope_changed';
      };
      let response: ProcessingReview | undefined;
      if (command === 'review_processing_scope') {
        requireScope();
        if (!state().processor || state().capture !== 'running')
          throw 'unavailable';
        const scope = (args as { scope: ProcessingScope }).scope;
        response = structuredClone({
          id: `review-${++reviewNumber}`,
          session: state().session,
          scopeRevision: state().scopeRevision,
          processor: state().processor!,
          scope,
          notes: state().notes.filter((note) =>
            scope.notes.some((item) => noteKey(item) === noteKey(note)),
          ),
        });
        reviews.set(response.id, response);
      }
      if (delays.delete(command))
        await new Promise<void>((resolve) => releases.set(command, resolve));
      if (failures.delete(command)) {
        if (command === 'approve_processing_scope')
          reviews.delete((args as { id: string }).id);
        throw 'PRIVATE_PROVIDER_ERROR';
      }
      switch (command) {
        case 'review_processing_scope':
          return response;
        case 'cancel_processing_review':
          reviews.delete((args as { id: string }).id);
          return;
        case 'approve_processing_scope': {
          const review = reviews.get((args as { id: string }).id);
          if (
            !review ||
            review.session !== state().session ||
            review.scopeRevision !== state().scopeRevision ||
            state().capture !== 'running'
          )
            throw 'scope_changed';
          await boundary({
            phase: 'active',
            approved: review.scope,
            issue: null,
          });
          return;
        }
        case 'set_processing_paused':
          requireScope();
          if (!state().approved || state().capture !== 'running')
            throw 'scope_changed';
          await boundary({
            phase: (args as { paused: boolean }).paused ? 'paused' : 'active',
          });
          return;
        case 'revoke_processing':
          requireScope();
          await boundary({ phase: 'off', approved: null, issue: null });
          return;
        default:
          throw 'unexpected_command';
      }
    },
  };
}

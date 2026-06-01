import {
  LocalDurableTestRunner,
  OperationType,
  OperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import { handler } from './handler';
import * as bedrock from './bedrock';
import { AnalysisResult, RegionFinding, AnalysisSynthesis } from './types';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Keep parseImageFormat real; only mock the async Bedrock calls.
jest.mock('./bedrock', () => ({
  ...jest.requireActual('./bedrock'),
  invokeNova: jest.fn(),
  invokeNovaText: jest.fn(),
}));
const mockInvokeNova = bedrock.invokeNova as jest.MockedFunction<typeof bedrock.invokeNova>;
const mockInvokeNovaText = bedrock.invokeNovaText as jest.MockedFunction<typeof bedrock.invokeNovaText>;

const FAKE_REGION_ANALYSIS =
  'Objects: person, bicycle. Features: sharp edges, high contrast. ' +
  'Good segmentation target with clear object boundaries.';

const FAKE_SYNTHESIS: AnalysisSynthesis = {
  overallDescription: 'Urban street scene with pedestrians and cyclists.',
  dominantObjects: ['person', 'bicycle', 'road'],
  sceneType: 'urban-street',
  cvInsights: [
    'High occlusion between pedestrians challenges instance segmentation.',
    'Mixed lighting from streetlamps and daylight increases HDR complexity.',
    'Dynamic blur on cyclists useful for optical flow benchmarks.',
  ],
};

// ── Fixture ───────────────────────────────────────────────────────────────────

const PAYLOAD = {
  imageId: 'img-cvpr-001',
  imageBase64: Buffer.from('fake-image-bytes').toString('base64'),
  imageMediaType: 'image/jpeg' as const,
  gridSize: 2, // 2×2 = 4 regions — fast for tests
};

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(() =>
  LocalDurableTestRunner.setupTestEnvironment({ skipTime: true })
);

afterAll(() =>
  LocalDurableTestRunner.teardownTestEnvironment()
);

beforeEach(() => {
  mockInvokeNova.mockResolvedValue(FAKE_REGION_ANALYSIS);
  mockInvokeNovaText.mockResolvedValue(
    JSON.stringify(FAKE_SYNTHESIS)
  );
});

afterEach(() => jest.clearAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('image analysis pipeline', () => {
  it('completes all four pipeline steps', async () => {
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: PAYLOAD });

    expect(execution.getStatus()).toBe('SUCCEEDED');

    const preprocess = runner.getOperation('preprocess');
    expect(preprocess.getType()).toBe(OperationType.STEP);
    expect(preprocess.getStatus()).toBe(OperationStatus.SUCCEEDED);

    const mapOp = runner.getOperation('analyze-regions');
    expect(mapOp.getType()).toBe(OperationType.CONTEXT);
    expect(mapOp.getStatus()).toBe(OperationStatus.SUCCEEDED);

    const synthesize = runner.getOperation('synthesize');
    expect(synthesize.getType()).toBe(OperationType.STEP);
    expect(synthesize.getStatus()).toBe(OperationStatus.SUCCEEDED);

    const store = runner.getOperation('store');
    expect(store.getType()).toBe(OperationType.STEP);
    expect(store.getStatus()).toBe(OperationStatus.SUCCEEDED);
  });

  it('fans out one step per region', async () => {
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    await runner.run({ payload: PAYLOAD });

    // 2×2 grid → 4 region steps
    for (let i = 0; i < 4; i++) {
      const regionStep = runner.getOperation(`analyze-region-${i}`);
      expect(regionStep.getStatus()).toBe(OperationStatus.SUCCEEDED);
    }
    expect(mockInvokeNova).toHaveBeenCalledTimes(4);
  });

  it('returns well-formed AnalysisResult', async () => {
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: PAYLOAD });

    const result = execution.getResult() as AnalysisResult;
    expect(result.imageId).toBe('img-cvpr-001');
    expect(result.regionCount).toBe(4);
    expect(result.successfulRegions).toBe(4);
    expect(result.findings).toHaveLength(4);
    expect(result.synthesis.sceneType).toBe('urban-street');
    expect(result.synthesis.cvInsights).toHaveLength(3);
    expect(typeof result.storedAt).toBe('string');
  });

  it('is deterministic across replays', async () => {
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });

    const exec1 = await runner.run({ payload: PAYLOAD });
    const exec2 = await runner.run({ payload: PAYLOAD });

    const r1 = exec1.getResult() as AnalysisResult;
    const r2 = exec2.getResult() as AnalysisResult;

    expect(r1.imageId).toBe(r2.imageId);
    expect(r1.synthesis.sceneType).toBe(r2.synthesis.sceneType);
    expect(r1.findings.map((f: RegionFinding) => f.regionIndex)).toEqual(
      r2.findings.map((f: RegionFinding) => f.regionIndex)
    );
  });

  it('tolerates a failing region and still synthesizes', async () => {
    // Make region 0 always fail (even on retries) by checking the prompt
    mockInvokeNova.mockImplementation(async (prompt) => {
      if (prompt.includes('region-0-0')) throw new Error('Permanent Bedrock failure for region 0');
      return FAKE_REGION_ANALYSIS;
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: PAYLOAD });

    expect(execution.getStatus()).toBe('SUCCEEDED');

    const result = execution.getResult() as AnalysisResult;
    expect(result.successfulRegions).toBeLessThan(result.regionCount);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('invokes Nova once per region with correct image payload', async () => {
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    await runner.run({ payload: PAYLOAD });

    const calls = mockInvokeNova.mock.calls;
    expect(calls.length).toBe(4);
    // Every call receives the same base64 image
    calls.forEach(([, imgArg]) => expect(imgArg).toBe(PAYLOAD.imageBase64));
    // Format derived from imageMediaType
    calls.forEach(([, , fmtArg]) => expect(fmtArg).toBe('jpeg'));
  });
});

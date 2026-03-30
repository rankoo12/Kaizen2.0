import { LearnedCompiler } from '../learned.compiler';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { StepAST, CandidateNode } from '../../../types';

describe('LearnedCompiler', () => {
  let mockLLMGateway: ILLMGateway;
  let mockObservability: IObservability;
  let compiler: LearnedCompiler;

  beforeEach(() => {
    mockLLMGateway = {
      compileStep: jest.fn(),
      // Adding resolveElement to fulfill the ILLMGateway interface strictly
      resolveElement: jest.fn(),
    };

    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    };

    compiler = new LearnedCompiler(mockLLMGateway, mockObservability);
  });

  it('compiles pre-seeded standard phrases instantly from cache without calling LLM', async () => {
    const rawText = "search for cats";
    const ast = await compiler.compile(rawText);

    expect(ast.action).toBe('type');
    expect(ast.value).toBe('cats');
    expect(ast.targetDescription).toBe('search box');
    expect(ast.contentHash).toBeDefined();

    // Verify LLM was bypassed
    expect(mockLLMGateway.compileStep).not.toHaveBeenCalled();
    expect(mockObservability.increment).toHaveBeenCalledWith('compiler.cache_hit');
  });

  it('calls LLMGateway on Cache Misses, then remembers it for subsequent identical calls', async () => {
    const customText = "smash the subscribe button";
    
    const fakeLLMAst: StepAST = {
      action: 'click',
      targetDescription: 'subscribe button',
      value: null,
      url: null,
      rawText: customText,
      contentHash: 'hash-stub' // Overwritten by compiler anyway
    };

    (mockLLMGateway.compileStep as jest.Mock).mockResolvedValueOnce(fakeLLMAst);

    // Call 1: Cache Miss
    const ast1 = await compiler.compile(customText);
    expect(ast1.action).toBe('click');
    expect(ast1.targetDescription).toBe('subscribe button');
    expect(mockLLMGateway.compileStep).toHaveBeenCalledTimes(1);
    expect(mockObservability.increment).toHaveBeenCalledWith('compiler.cache_miss');

    // Call 2: Cache Hit
    const ast2 = await compiler.compile(customText);
    expect(ast2).toEqual(ast1); // Should return EXACT structure from memory dictionary
    
    // Crucially, it did NOT call the LLM a second time for the exact same phrasing!
    expect(mockLLMGateway.compileStep).toHaveBeenCalledTimes(1); 
  });
});

import type { JournalAiInsights } from "@/lib/journal";

interface DeepseekResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-chat";

function cleanJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") && !trimmed.endsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseInsights(text: string): JournalAiInsights | null {
  try {
    const parsed = JSON.parse(cleanJsonFence(text)) as Partial<JournalAiInsights>;
    if (!parsed.title || !parsed.whatWeFound || !parsed.whyItMatters || !parsed.psychology || !parsed.whatToDo || !parsed.basis) {
      return null;
    }

    const confidence = parsed.confidence === "low" || parsed.confidence === "high" ? parsed.confidence : "medium";

    return {
      title: String(parsed.title),
      confidence,
      whatWeFound: {
        statement: String(parsed.whatWeFound.statement ?? ""),
        pValueText: String(parsed.whatWeFound.pValueText ?? "n/a"),
        significant: Boolean(parsed.whatWeFound.significant),
        effectSizeText: String(parsed.whatWeFound.effectSizeText ?? "n/a"),
      },
      whyItMatters: String(parsed.whyItMatters),
      psychology: {
        biasName: String(parsed.psychology.biasName ?? "Action Bias"),
        explanation: String(parsed.psychology.explanation ?? ""),
        reference: String(parsed.psychology.reference ?? "Behavioral finance literature"),
      },
      whatToDo: {
        primaryAction: {
          title: String(parsed.whatToDo.primaryAction?.title ?? "Primary action"),
          description: String(parsed.whatToDo.primaryAction?.description ?? ""),
          cta: String(parsed.whatToDo.primaryAction?.cta ?? "Apply"),
        },
        secondaryAction: {
          title: String(parsed.whatToDo.secondaryAction?.title ?? "Secondary action"),
          description: String(parsed.whatToDo.secondaryAction?.description ?? ""),
          cta: String(parsed.whatToDo.secondaryAction?.cta ?? "Review"),
        },
      },
      basis: {
        tradesAnalyzed: Number(parsed.basis.tradesAnalyzed ?? 0),
        minimumRequired: Number(parsed.basis.minimumRequired ?? 30),
      },
    };
  } catch {
    return null;
  }
}

export async function generateDeepseekInsights(prompt: string): Promise<JournalAiInsights> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    return {
      title: "AI insights unavailable",
      confidence: "low",
      whatWeFound: {
        statement: "Set DEEPSEEK_API_KEY in .env.local to enable AI coaching.",
        pValueText: "n/a",
        significant: false,
        effectSizeText: "n/a",
      },
      whyItMatters: "Behavioral analytics is available, but narrative coaching is disabled until API key is configured.",
      psychology: {
        biasName: "Action Bias",
        explanation: "When uncertainty rises, humans tend to over-act rather than pause and reassess.",
        reference: "Behavioral finance studies",
      },
      whatToDo: {
        primaryAction: {
          title: "Enable DeepSeek",
          description: "Add DEEPSEEK_API_KEY and refresh the journal.",
          cta: "Enable AI",
        },
        secondaryAction: {
          title: "Use rule engine",
          description: "Continue using leak buckets and trade-level flags for objective feedback.",
          cta: "View leaks",
        },
      },
      basis: {
        tradesAnalyzed: 0,
        minimumRequired: 30,
      },
    };
  }

  const model = process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;

  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content:
            "You are an elite trading behavior analyst. Be strict, concise, evidence-led, and action-oriented. Never invent fake precision. Output valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`DeepSeek request failed (${response.status})`);
  }

  const payload = (await response.json()) as DeepseekResponse;
  const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
  const parsed = parseInsights(text);
  if (!parsed) {
    return {
      title: "AI generated non-standard response",
      confidence: "low",
      whatWeFound: {
        statement: text ? text.slice(0, 220) : "Raw model output could not be parsed.",
        pValueText: "n/a",
        significant: false,
        effectSizeText: "n/a",
      },
      whyItMatters: "Structured coaching could not be created from the model output.",
      psychology: {
        biasName: "Action Bias",
        explanation: "Under pressure, decisions become reactive and process quality drops.",
        reference: "Behavioral finance literature",
      },
      whatToDo: {
        primaryAction: {
          title: "Use fallback rules",
          description: "Apply fixed cooldown and max-trades constraints for next session.",
          cta: "Apply rules",
        },
        secondaryAction: {
          title: "Retry analysis",
          description: "Refresh AI analysis to request a strict JSON output again.",
          cta: "Retry",
        },
      },
      basis: {
        tradesAnalyzed: 0,
        minimumRequired: 30,
      },
    };
  }
  return parsed;
}

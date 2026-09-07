// @ts-nocheck
/**
 * Help content for the "?" button on each AI tool.
 *
 * Content is data, not JSX, so one modal renders every topic. Limit lines are
 * functions of the live /api/ai/status payload rather than literal numbers —
 * that way the help can never quote a cap the server is not actually applying.
 */

/** Format a byte-ish megabyte value for display. */
function mb(value) {
  return `${value} MB`
}

/** Turn a character cap into an approximate word count users can reason about. */
function approxWords(chars) {
  return Math.round(chars / 6).toLocaleString()
}

const TOPICS = {
  chat: {
    title: "Chat using AI",
    intro:
      "Ask anything in plain language. Chat remembers the current conversation, can read replies aloud, and can look at images you attach.",
    sections: [
      {
        heading: "Tips",
        items: [
          "Follow-up questions work — you do not have to repeat context.",
          "Use the microphone to talk instead of type.",
          "Conversation Mode reads replies aloud; use Pause audio if you need a moment, and Stop audio to end playback.",
          "In Conversation Mode, you can say “exit”, “bye”, or “quit” at any time to end the session.",
          "Attach an image to have it described or analysed.",
          "Signed-in chats auto-save to MongoDB. Use History to reopen a thread; Clear Chat starts a new one after confirming.",
        ],
      },
    ],
    limits: (limits) => [
      `Message length: up to ${limits.chat.maxChars.toLocaleString()} characters (roughly ${approxWords(
        limits.chat.maxChars
      )} words).`,
      `Read aloud: up to ${limits.tts.maxChars.toLocaleString()} characters per reply.`,
      `Image attachments: up to ${mb(limits.image.maxUploadMb)} each.`,
    ],
  },

  images: {
    title: "Images using AI",
    intro:
      "Describe a picture in words and the model draws it. You can also upload an existing image and ask questions about it.",
    sections: [
      {
        heading: "Writing a good prompt",
        items: [
          "Name the subject, the setting, and the style: “a red fox in snow at dusk, watercolour”.",
          "Add detail about lighting and mood — these change the result more than adjectives do.",
          "“Fast & inexpensive” is good for trying ideas; switch to “Better quality” once you like the direction.",
        ],
      },
      {
        heading: "Good to know",
        items: [
          "Each generation counts against your daily allowance, whether or not you keep the result.",
          "If generation fails, the attempt is refunded automatically.",
          "Your allowance resets at midnight UTC.",
        ],
      },
    ],
    limits: (limits, status) => {
      const lines = []
      if (limits.image.dailyLimit <= 0) {
        lines.push("Image generation is currently switched off.")
      } else if (status?.signedIn) {
        lines.push(`Generated images: ${limits.image.dailyLimit} per day.`)
      } else {
        lines.push(
          `Generating images requires signing in. Accounts get ${limits.image.dailyLimit} per day; guest sessions cannot be metered, so they get none.`
        )
      }
      lines.push(
        `Prompt length: up to ${limits.image.maxPromptChars.toLocaleString()} characters.`,
        `Uploads for analysis: up to ${mb(limits.image.maxUploadMb)} each — this works as a guest.`
      )
      return lines
    },
  },

  rag: {
    title: "Documents (Q&A) using AI",
    intro:
      "Upload documents, then ask questions about them. Answers are drawn from the text you uploaded and cite the passages they came from.",
    sections: [
      {
        heading: "How to use it",
        items: [
          "Upload a PDF, .txt, or .md file and wait for its status to reach “ready”.",
          "Check one or more documents to search, or use All docs.",
          "Ask a specific question — “what is the cancellation notice period?” beats “summarise this”.",
          "Delete documents you no longer need to free up space in your library.",
        ],
      },
      {
        heading: "Good to know",
        items: [
          "Answers come only from your uploaded text, so the model will say when something is not covered.",
          "Scanned PDFs with no selectable text cannot be read — there is nothing to extract.",
        ],
      },
    ],
    limits: (limits) => [
      `Library size: up to ${limits.rag.maxDocs} documents at a time.`,
      `File size: up to ${mb(limits.rag.maxUploadMb)} per upload.`,
      `Question length: up to ${limits.rag.maxQuestionChars.toLocaleString()} characters.`,
      "Documents require a signed-in account.",
    ],
  },
}

/** Look up a help topic by key. Returns null for unknown keys. */
export function getHelpTopic(key) {
  return TOPICS[key] || null
}

/**
 * Resolve a topic's limit lines against a live status payload.
 * Returns [] when status has not loaded yet, so the modal can show a placeholder.
 */
export function resolveHelpLimits(key, status) {
  const topic = TOPICS[key]
  if (!topic?.limits || !status?.limits) return []
  try {
    return topic.limits(status.limits, status)
  } catch {
    return []
  }
}

export const HELP_TOPIC_KEYS = Object.keys(TOPICS)

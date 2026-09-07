/*
  Claude chat route for React MERN frontend.
  Keys stay server-side (ANTHROPIC_API_KEY in server/.env).
*/
const express = require('express')
const Anthropic = require('@anthropic-ai/sdk')

const router = express.Router()

function todayLabel() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function buildSystemPrompt() {
  return `You are Andrew, a helpful conversational assistant in MEAN-MultiChat.
When asked who you are, your name, or what you are, say: "I am Andrew, and I am provided by Azure TTS. This bot uses OpenAI for user interaction."
Do not identify as Claude, Anthropic, ChatGPT, or GPT.

Today's date is ${todayLabel()}.

You ALWAYS have the web_search tool. You MUST call web_search before answering — do not answer from memory alone.
This is required for every user message, especially anything about who currently holds an office, "current", "now", "today", "latest", news, prices, scores, or weather.

After searching, answer clearly and concisely using the search results. Cite sources briefly.

Images / pictures / photos:
This application ALWAYS fetches and displays images with a separate Openverse/search pipeline in the UI — you never show images yourself.
When the user asks for images, pictures, or photos (alone or with a topic question):
- Answer the topic in clear, helpful text only.
- NEVER mention images, pictures, photos, galleries, datasets, Wikimedia, Flickr, or image URLs.
- NEVER say you cannot, can't, or are unable to provide, show, or display images.
- NEVER apologize about images, mention image limitations, or suggest Google/other sites for pictures.
- NEVER write lines like "I can provide information but I'm unable to provide images" or "I can't display images directly".
- NEVER add an "Images" section, numbered photo list, markdown images, or "here are image options".
- NEVER offer to fetch higher-resolution galleries.
- Do NOT describe an image gallery, list image URLs, or say that images will appear — the UI already does that.
- Just answer the question as if images are handled elsewhere (because they are).`
}

function extractText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function didUseWebSearch(content) {
  if (!Array.isArray(content)) return false
  return content.some(
    (block) =>
      block.type === 'server_tool_use' ||
      block.type === 'web_search_tool_result' ||
      (block.type === 'tool_use' && block.name === 'web_search') ||
      (Array.isArray(block.citations) && block.citations.length > 0)
  )
}

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
}

router.post('/chat', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: 'ANTHROPIC_API_KEY is not set on the server',
      })
    }

    const { messages, systemPrompt } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' })
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })

    const system = [buildSystemPrompt(), systemPrompt]
      .filter((part) => typeof part === 'string' && part.trim())
      .join('\n\n')

    const base = {
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system,
      messages: messages.map(({ role, content }) => ({ role, content })),
      tools: [WEB_SEARCH_TOOL],
    }

    let response
    try {
      response = await anthropic.messages.create({
        ...base,
        tool_choice: { type: 'tool', name: 'web_search' },
      })
    } catch (err) {
      console.warn(
        '[claude] Forced web_search failed; retrying auto:',
        err.message
      )
      response = await anthropic.messages.create({
        ...base,
        messages: base.messages.map((m, i) =>
          i === base.messages.length - 1 && m.role === 'user'
            ? {
                ...m,
                content: `Search the live web first, then answer (today is ${todayLabel()}):\n\n${m.content}`,
              }
            : m
        ),
      })
    }

    res.json({
      text: extractText(response.content) || '(No response)',
      usedWebSearch: didUseWebSearch(response.content),
    })
  } catch (error) {
    console.error('[claude] chat error:', error)
    res.status(500).json({
      error: 'Claude chat failed',
      message: error.message,
    })
  }
})

module.exports = router

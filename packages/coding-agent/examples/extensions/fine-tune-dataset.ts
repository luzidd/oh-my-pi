/**
 * Fine-Tuning Dataset Extension
 *
 * Collects conversation turns with quality ratings for building fine-tuning
 * datasets. Logs rated prompt/response pairs (including thinking content if present)
 * that can be post-processed into SFT, DPO, or other training formats offline.
 *
 * Usage:
 *   pi --extension examples/extensions/fine-tune-dataset.ts
 *   pi --extension examples/extensions/fine-tune-dataset.ts --fine-tune-dir /path/to/dir
 *
 * After each assistant response, you'll be prompted to rate the quality.
 * Data is saved to the configured directory (default: ~/.omp/fine-tune-data).
 *
 * Output file:
 *   - rated-turns.jsonl: {"timestamp": 123, "prompt": "...", "thinking": "..." | undefined, "response": "...", "rating": 5, "model": "...", "provider": "..."}
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage, TextContent, ThinkingContent } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface Turn {
	userMessage: string;
	assistantMessage: string;
	assistantRaw: AssistantMessage;
	thinking?: string;
}

interface RatedTurn extends Turn {
	rating: number;
	timestamp: number;
}

export default function (pi: ExtensionAPI) {
	// Register the configuration flag
	pi.registerFlag("fine-tune-dir", {
		description: "Directory to save fine-tuning dataset logs",
		type: "string",
		default: path.join(os.homedir(), ".omp", "fine-tune-data"),
	});

	const dataDir = pi.getFlag("fine-tune-dir") ?? path.join(os.homedir(), ".omp", "fine-tune-data");
	const logFile = path.join(dataDir, "rated-turns.jsonl");

	let pendingTurn: Turn | null = null;
	let lastUserMessage: string | null = null;

	// Capture user messages from context event
	pi.on("context", async event => {
		// Find the last user message in the context
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i];
			if (msg.role === "user") {
				const content = msg.content;
				if (typeof content === "string") {
					lastUserMessage = content;
				} else {
					// Extract text from content array
					const textParts = content
						.filter((c): c is TextContent => c.type === "text")
						.map(c => c.text)
						.join("\n");
					if (textParts) {
						lastUserMessage = textParts;
					}
				}
				break;
			}
		}
		return undefined;
	});

	// Capture assistant responses
	pi.on("turn_end", async (event, ctx) => {
		const assistantMsg = event.message;
		if (assistantMsg.role !== "assistant") return;

		// Extract thinking content from assistant message
		const thinking = assistantMsg.content
			.filter((c): c is ThinkingContent => c.type === "thinking")
			.map(c => c.thinking)
			.join("\n");

		// Extract text content from assistant message
		const textContent = assistantMsg.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");

		if (!textContent || !lastUserMessage) return;

		pendingTurn = {
			userMessage: lastUserMessage,
			assistantMessage: textContent,
			assistantRaw: assistantMsg,
			thinking: thinking || undefined,
		};

		// Ask user to rate this response
		try {
			const ratingChoice = await ctx.ui.select(
				"Rate this response for fine-tuning dataset",
				[
					{ label: "5 - Excellent", value: "5" },
					{ label: "4 - Good", value: "4" },
					{ label: "3 - Acceptable", value: "3" },
					{ label: "2 - Poor", value: "2" },
					{ label: "1 - Very Poor", value: "1" },
					{ label: "Skip - Don't save", value: "0" },
				],
				{
					description: `User: ${truncate(lastUserMessage, 100)}\n\nAssistant: ${truncate(textContent, 200)}`,
				},
			);

			const rating = Number.parseInt(ratingChoice, 10);

			if (rating === 0) {
				// User chose to skip
				pendingTurn = null;
				return;
			}

			const ratedTurn: RatedTurn = {
				...pendingTurn,
				rating,
				timestamp: Date.now(),
			};

			// Log the atomic turn
			await logTurn(ratedTurn);

			pi.logger.debug("Saved turn to fine-tuning dataset", {
				rating,
				userLength: lastUserMessage.length,
				assistantLength: textContent.length,
			});
		} catch (error) {
			pi.logger.warn("Failed to collect rating", { error });
		} finally {
			pendingTurn = null;
		}
	});

	// Log the atomic turn
	async function logTurn(turn: RatedTurn): Promise<void> {
		const entry = {
			timestamp: turn.timestamp,
			prompt: turn.userMessage,
			thinking: turn.thinking,
			response: turn.assistantMessage,
			rating: turn.rating,
			model: turn.assistantRaw.model,
			provider: turn.assistantRaw.provider,
		};

		try {
			// Ensure directory exists before appending
			await fs.mkdir(dataDir, { recursive: true });
			const jsonLine = JSON.stringify(entry) + "\n";
			await fs.appendFile(logFile, jsonLine);
		} catch (error) {
			pi.logger.error("Failed to write turn to dataset", { error });
		}
	}

	// Utility: truncate text for display
	function truncate(text: string, maxLength: number): string {
		if (text.length <= maxLength) return text;
		return `${text.slice(0, maxLength)}...`;
	}

	// Log startup
	pi.logger.info("Fine-tune dataset extension loaded", {
		dataDir,
		logFile,
	});
}

/**
 * Fine-Tuning Dataset Extension
 *
 * Collects conversation turns and prompts for quality ratings to build
 * fine-tuning datasets in SFT (Supervised Fine-Tuning) and DPO (Direct
 * Preference Optimization) formats.
 *
 * Usage:
 *   pi --extension examples/extensions/fine-tune-dataset.ts
 *
 * After each assistant response, you'll be prompted to rate the quality.
 * Data is saved to ~/.omp/fine-tune-data/ in JSONL format.
 *
 * Output files:
 *   - sft-dataset.jsonl: {"messages": [{"role": "user", "content": "..."},
 *                                      {"role": "assistant", "content": "..."}]}
 *   - dpo-dataset.jsonl: {"prompt": "...", "chosen": "...", "rejected": "...",
 *                        "chosen_rating": N, "rejected_rating": M}
 *
 * For DPO: Pairs of responses with different ratings become chosen/rejected pairs.
 * Lower-rated responses are automatically used as "rejected" examples when
 * a higher-rated response exists for the same prompt.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface Turn {
	userMessage: string;
	assistantMessage: string;
	assistantRaw: AssistantMessage;
}

interface RatedTurn extends Turn {
	rating: number;
	timestamp: number;
}

interface DPOCandidate {
	prompt: string;
	responses: Array<{ content: string; rating: number; timestamp: number }>;
}

export default function (pi: ExtensionAPI) {
	const dataDir = path.join(os.homedir(), ".omp", "fine-tune-data");
	const sftFile = path.join(dataDir, "sft-dataset.jsonl");
	const dpoFile = path.join(dataDir, "dpo-dataset.jsonl");

	let pendingTurn: Turn | null = null;
	let lastUserMessage: string | null = null;

	// Track responses for the same prompt for DPO pairing
	const dpoBuffer = new Map<string, DPOCandidate>();

	// Ensure data directory exists
	fs.mkdir(dataDir, { recursive: true }).catch(err => {
		pi.logger.error("Failed to create fine-tune data directory", { error: err });
	});

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

			// Save to SFT format (all rated responses)
			await saveSFT(ratedTurn);

			// Buffer for DPO pairing
			await bufferForDPO(ratedTurn);

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

	// Save SFT format: standard chat format
	async function saveSFT(turn: RatedTurn): Promise<void> {
		const sftEntry = {
			messages: [
				{ role: "user", content: turn.userMessage },
				{ role: "assistant", content: turn.assistantMessage },
			],
			rating: turn.rating,
			timestamp: turn.timestamp,
			model: turn.assistantRaw.model,
			provider: turn.assistantRaw.provider,
		};

		try {
			const jsonLine = JSON.stringify(sftEntry) + "\n";
			await Bun.write(sftFile, jsonLine, { createPath: true });
		} catch (error) {
			pi.logger.error("Failed to write SFT entry", { error });
		}
	}

	// Buffer responses for DPO pairing
	async function bufferForDPO(turn: RatedTurn): Promise<void> {
		const prompt = turn.userMessage;
		let candidate = dpoBuffer.get(prompt);

		if (!candidate) {
			candidate = { prompt, responses: [] };
			dpoBuffer.set(prompt, candidate);
		}

		candidate.responses.push({
			content: turn.assistantMessage,
			rating: turn.rating,
			timestamp: turn.timestamp,
		});

		// If we have multiple responses for the same prompt, try to create DPO pairs
		if (candidate.responses.length >= 2) {
			await createDPOPairs(candidate);
		}
	}

	// Create DPO pairs: higher-rated = chosen, lower-rated = rejected
	async function createDPOPairs(candidate: DPOCandidate): Promise<void> {
		const responses = candidate.responses;

		// Sort by rating descending
		responses.sort((a, b) => b.rating - a.rating);

		// Create pairs: best responses as "chosen", worse responses as "rejected"
		for (let i = 0; i < responses.length - 1; i++) {
			const chosen = responses[i];
			for (let j = i + 1; j < responses.length; j++) {
				const rejected = responses[j];

				// Only create pair if there's a meaningful rating difference
				if (chosen.rating > rejected.rating) {
					const dpoEntry = {
						prompt: candidate.prompt,
						chosen: chosen.content,
						rejected: rejected.content,
						chosen_rating: chosen.rating,
						rejected_rating: rejected.rating,
						timestamp: Math.max(chosen.timestamp, rejected.timestamp),
					};

					try {
						const jsonLine = JSON.stringify(dpoEntry) + "\n";
						await Bun.write(dpoFile, jsonLine, { createPath: true });
					} catch (error) {
						pi.logger.error("Failed to write DPO entry", { error });
					}
				}
			}
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
		sftFile,
		dpoFile,
	});
}

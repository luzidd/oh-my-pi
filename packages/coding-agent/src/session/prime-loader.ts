/**
 * Load priming conversation from a session file
 */
import { logger } from "@oh-my-pi/pi-utils";
import { SessionManager } from "./session-manager";
import type { SessionEntry, SessionMessageEntry, CustomMessageEntry } from "./session-manager";
import { loadEntriesFromFile, type SessionStorage } from "./session-manager";

export interface PrimeOptions {
	/** Maximum number of messages to load from the prime file */
	maxMessages?: number;
	/** Session storage backend (defaults to FileSessionStorage) */
	storage?: SessionStorage;
}

/**
 * Load priming messages from a session file and pre-populate a new SessionManager.
 * Only loads message entries (user, assistant, toolResult), ignores metadata entries
 * like compaction, model changes, etc.
 *
 * @param primePath Path to session JSONL file to load priming from
 * @param cwd Working directory for the new session
 * @param options Optional configuration
 * @returns SessionManager pre-populated with priming messages
 */
export async function loadPrimingSession(
	primePath: string,
	cwd: string,
	options: PrimeOptions = {},
): Promise<SessionManager> {
	const { maxMessages, storage } = options;

	logger.info("Loading priming conversation", { primePath, maxMessages });

	// Load entries from the prime file
	let entries: (SessionMessageEntry | CustomMessageEntry)[];
	try {
		const fileEntries = await loadEntriesFromFile(primePath, storage);
		// Filter out header and metadata entries, keep only messages
		entries = fileEntries.filter(
			(e): e is SessionMessageEntry | CustomMessageEntry => e.type === "message" || e.type === "custom_message",
		);
	} catch (err) {
		logger.error("Failed to load prime file", { path: primePath, error: String(err) });
		throw new Error(`Failed to load prime file: ${primePath}`);
	}

	if (entries.length === 0) {
		logger.warn("Prime file contains no messages", { path: primePath });
	}

	// Limit messages if requested
	if (maxMessages !== undefined && maxMessages > 0 && entries.length > maxMessages) {
		logger.info("Limiting prime messages", { total: entries.length, limit: maxMessages });
		entries = entries.slice(0, maxMessages);
	}

	// Create new session and populate with priming messages
	const sessionManager = SessionManager.inMemory(cwd, storage);

	let messageCount = 0;
	for (const entry of entries) {
		if (entry.type === "message") {
			sessionManager.appendMessage(entry.message);
			messageCount++;
		} else if (entry.type === "custom_message") {
			sessionManager.appendCustomMessageEntry(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.attribution,
			);
			messageCount++;
		}
	}

	logger.info("Loaded priming conversation", { messages: messageCount, path: primePath });

	return sessionManager;
}

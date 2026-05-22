#!/usr/bin/env python3
"""
Batch Rating Tool for oh-my-pi Sessions

Processes existing session JSONL files, extracts conversation segments with context,
and collects quality ratings for building fine-tuning datasets.

Usage:
    python scripts/rate-sessions.py                      # Rate all sessions
    python scripts/rate-sessions.py --recent 7           # Last 7 days only
    python scripts/rate-sessions.py --context-turns 5    # Include 5 prior turns
    python scripts/rate-sessions.py --session <path>     # Rate specific session

Output:
    ~/.omp/fine-tune-data/rated-turns.jsonl
    
The output file contains one entry per rated conversation segment:
    {
        "messages": [
            {"role": "user", "content": "..."},
            {"role": "assistant", "content": "...<tool_use>...</tool_use>"},
            {"role": "toolResult", "content": "<tool_result>...</tool_result>"},
            ...
        ],
        "rating": 1-5,
        "model": "...",
        "provider": "...",
        "session_id": "...",
        "timestamp": 1234567890
    }

Conversation context:
    Each entry includes the last N user-assistant exchanges plus the current turn,
    including tool calls and tool results. This provides full context for the agent's
    decision-making process.

Post-processing for training:
    - SFT: Filter rating >= 4, use messages array directly (includes tools)
    - DPO: Group by context, pair high/low ratings as chosen/rejected
    - Tool calls and results are preserved in <tool_use> and <tool_result> tags
"""

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional


class SessionRater:
    def __init__(self, output_file: Path, context_turns: int = 3, skip_rated: bool = True):
        self.output_file = output_file
        self.context_turns = context_turns
        self.skip_rated = skip_rated
        self.rated_sessions: set[str] = set()
        self.stats = {
            "sessions_processed": 0,
            "turns_rated": 0,
            "turns_skipped": 0,
            "ratings": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0},
        }
        
        # Load already-rated session IDs if resuming
        if skip_rated and output_file.exists():
            self._load_rated_sessions()
    
    def _load_rated_sessions(self):
        """Load session IDs that have already been rated."""
        try:
            with open(self.output_file) as f:
                for line in f:
                    entry = json.loads(line)
                    self.rated_sessions.add(entry.get("session_id", ""))
        except Exception as e:
            print(f"⚠️  Warning: Could not load existing ratings: {e}")
    
    def load_session(self, session_file: Path) -> tuple[str, List[Dict[str, Any]]]:
        """Load and parse session JSONL file."""
        messages = []
        session_id = ""
        
        try:
            with open(session_file) as f:
                for line in f:
                    entry = json.loads(line)
                    
                    if entry.get("type") == "session":
                        session_id = entry.get("id", "")
                    
                    elif entry.get("type") == "message":
                        messages.append(entry["message"])
        except Exception as e:
            print(f"❌ Error reading {session_file.name}: {e}")
            return "", []
        
        return session_id, messages
    
    def extract_conversations(self, messages: List[Dict[str, Any]], session_id: str) -> List[Dict[str, Any]]:
        """Extract conversation segments with context window, including tool calls and results."""
        # First, parse all messages into training format
        parsed_messages = []
        
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", [])
            
            if role == "user":
                # Extract text from content array
                if isinstance(content, str):
                    text = content
                else:
                    text = "\n".join(
                        c.get("text", "") 
                        for c in content 
                        if c.get("type") == "text"
                    )
                
                if text.strip():
                    parsed_messages.append({
                        "role": "user",
                        "content": text,
                        "timestamp": msg.get("timestamp"),
                    })
            
            elif role == "assistant":
                # Extract thinking, text, and tool calls
                thinking_parts = []
                text_parts = []
                tool_calls = []
                
                if isinstance(content, str):
                    text_parts.append(content)
                else:
                    for c in content:
                        if c.get("type") == "thinking":
                            thinking_parts.append(c.get("thinking", ""))
                        elif c.get("type") == "text":
                            text_parts.append(c.get("text", ""))
                        elif c.get("type") == "toolCall":
                            # Format tool call as XML-like structure
                            tool_name = c.get("name", "unknown")
                            tool_id = c.get("id", "")
                            tool_args = c.get("arguments", {})
                            tool_calls.append({
                                "id": tool_id,
                                "name": tool_name,
                                "arguments": tool_args,
                            })
                
                # Build full content
                content_parts = []
                if thinking_parts:
                    content_parts.append(f"<thinking>\n{'\n'.join(thinking_parts)}\n</thinking>")
                if text_parts:
                    content_parts.append("\n".join(text_parts))
                
                # Add tool calls if present
                if tool_calls:
                    for tc in tool_calls:
                        content_parts.append(
                            f"<tool_use>\n"
                            f"<name>{tc['name']}</name>\n"
                            f"<id>{tc['id']}</id>\n"
                            f"<arguments>{json.dumps(tc['arguments'])}</arguments>\n"
                            f"</tool_use>"
                        )
                
                full_content = "\n".join(content_parts)
                
                if full_content.strip():
                    parsed_messages.append({
                        "role": "assistant",
                        "content": full_content,
                        "model": msg.get("model"),
                        "provider": msg.get("provider"),
                        "timestamp": msg.get("timestamp"),
                    })
            
            elif role == "toolResult":
                # Include tool results in the conversation
                tool_name = msg.get("toolName", "unknown")
                tool_id = msg.get("toolCallId", "")
                is_error = msg.get("isError", False)
                
                # Extract result content
                result_parts = []
                if isinstance(content, str):
                    result_parts.append(content)
                else:
                    for c in content:
                        if c.get("type") == "text":
                            result_parts.append(c.get("text", ""))
                        elif c.get("type") == "image":
                            result_parts.append("[Image output]")
                
                result_text = "\n".join(result_parts)
                
                # Format as tool result message
                content_str = (
                    f"<tool_result>\n"
                    f"<name>{tool_name}</name>\n"
                    f"<id>{tool_id}</id>\n"
                    f"<is_error>{is_error}</is_error>\n"
                    f"<content>\n{result_text}\n</content>\n"
                    f"</tool_result>"
                )
                
                parsed_messages.append({
                    "role": "toolResult",
                    "content": content_str,
                    "timestamp": msg.get("timestamp"),
                })
        
        # Now create conversation segments with sliding window
        # Group by user messages - each user message starts a new turn
        user_turn_starts = [
            i for i, m in enumerate(parsed_messages)
            if m["role"] == "user"
        ]
        
        conversations = []
        
        for turn_idx, user_idx in enumerate(user_turn_starts):
            # Find the end of this turn (next user message or end of conversation)
            if turn_idx + 1 < len(user_turn_starts):
                turn_end = user_turn_starts[turn_idx + 1]
            else:
                turn_end = len(parsed_messages)
            
            # Check if there's at least one assistant response in this turn
            turn_messages = parsed_messages[user_idx:turn_end]
            has_assistant = any(m["role"] == "assistant" for m in turn_messages)
            
            if not has_assistant:
                continue  # Skip incomplete turns
            
            # Find context start: go back N complete turns
            context_start = 0
            turns_back = 0
            for i in range(turn_idx - 1, -1, -1):
                turns_back += 1
                if turns_back >= self.context_turns:
                    context_start = user_turn_starts[i]
                    break
            
            # Build messages array: context + current turn
            context_messages = [
                {"role": m["role"], "content": m["content"]}
                for m in parsed_messages[context_start:turn_end]
            ]
            
            # Get metadata from last assistant message in this turn
            last_assistant = None
            for m in reversed(turn_messages):
                if m["role"] == "assistant":
                    last_assistant = m
                    break
            
            if last_assistant:
                conversations.append({
                    "messages": context_messages,
                    "model": last_assistant.get("model"),
                    "provider": last_assistant.get("provider"),
                    "session_id": session_id,
                    "timestamp": last_assistant.get("timestamp"),
                })
        
        return conversations
    
    def display_turn(self, turn: Dict[str, Any], index: int, total: int):
        """Display a conversation segment for rating."""
        print(f"\n{'='*70}")
        print(f"Turn {index + 1}/{total}")
        print(f"{'='*70}")
        
        messages = turn["messages"]
        
        # Find where current turn starts (last user message before final assistant)
        current_turn_start = 0
        user_indices = [i for i, m in enumerate(messages) if m["role"] == "user"]
        if user_indices:
            current_turn_start = user_indices[-1]
        
        # Show context messages (everything before current turn)
        if current_turn_start > 0:
            context_msgs = messages[:current_turn_start]
            print(f"\n📚 CONTEXT ({len(context_msgs)} prior messages):")
            
            # Show user messages from context with previews
            for i, msg in enumerate(context_msgs):
                if msg["role"] == "user":
                    preview = msg["content"][:100] + ("..." if len(msg["content"]) > 100 else "")
                    print(f"  👤 {preview}")
        
        # Show current turn (last user + all assistant/toolResult responses)
        print(f"\n{'─'*70}")
        print("CURRENT TURN:")
        print(f"{'─'*70}")
        
        current_turn_msgs = messages[current_turn_start:]
        
        for msg in current_turn_msgs:
            if msg["role"] == "user":
                user_content = msg["content"]
                user_preview = user_content[:500] + ("..." if len(user_content) > 500 else "")
                print(f"\n👤 USER ({len(user_content)} chars):")
                print(f"{user_preview}")
            
            elif msg["role"] == "assistant":
                assistant_content = msg["content"]
                # Show preview (thinking + text, skip tool_use tags for display)
                lines = assistant_content.split("\n")
                preview_lines = [l for l in lines[:10] if not l.startswith("<tool_use>")]
                assistant_preview = "\n".join(preview_lines)
                if len(assistant_content) > len(assistant_preview):
                    assistant_preview += "\n..."
                
                print(f"\n🤖 ASSISTANT ({len(assistant_content)} chars):")
                print(f"{assistant_preview}")
        
        # Metadata
        print(f"\n📊 Model: {turn['provider']}/{turn['model']}")
        if turn["timestamp"]:
            # Handle both integer (milliseconds) and ISO string timestamps
            if isinstance(turn["timestamp"], int):
                ts = datetime.fromtimestamp(turn["timestamp"] / 1000.0)
            else:
                ts = datetime.fromisoformat(turn["timestamp"].replace("Z", "+00:00"))
            print(f"📅 Time: {ts.strftime('%Y-%m-%d %H:%M:%S')}")
    
    def get_rating(self) -> Optional[int]:
        """Prompt user for rating. Returns None to quit, 0 to skip, 1-5 for rating."""
        print(f"\n{'─'*70}")
        print("Rate this turn:")
        print("  5 - Excellent    4 - Good    3 - Acceptable")
        print("  2 - Poor         1 - Very Poor")
        print("  s - Skip (don't save)    q - Quit")
        print(f"{'─'*70}")
        
        while True:
            try:
                choice = input("Your rating: ").strip().lower()
            except KeyboardInterrupt:
                print("\n\n👋 Interrupted, exiting...")
                return None
            
            if not choice:
                continue  # Empty input, prompt again
            
            if choice == "q":
                return None
            if choice == "s":
                return 0
            if choice in "12345":
                return int(choice)
            
            print("❌ Invalid input! Use 1-5, s, or q")
    
    def save_rated_turn(self, turn: Dict[str, Any], rating: int):
        """Append rated conversation to output file."""
        entry = {
            "messages": turn["messages"],
            "rating": rating,
            "model": turn["model"],
            "provider": turn["provider"],
            "session_id": turn["session_id"],
            "timestamp": turn["timestamp"],
        }
        
        try:
            with open(self.output_file, "a") as f:
                f.write(json.dumps(entry) + "\n")
            self.stats["turns_rated"] += 1
            self.stats["ratings"][rating] += 1
        except Exception as e:
            print(f"❌ Error saving turn: {e}")
    
    def rate_session(self, session_file: Path) -> bool:
        """Rate all turns in a session. Returns False if user quit."""
        print(f"\n📁 Processing: {session_file.name}")
        
        session_id, messages = self.load_session(session_file)
        
        if not messages:
            print("  ⚠️  No messages found, skipping")
            return True
        
        # Check if already rated
        if self.skip_rated and session_id in self.rated_sessions:
            print(f"  ⏭️  Already rated, skipping")
            return True
        
        turns = self.extract_conversations(messages, session_id)
        
        if not turns:
            print("  ⚠️  No conversation turns found, skipping")
            return True
        
        print(f"  → {len(turns)} turn(s) found")
        
        for i, turn in enumerate(turns):
            self.display_turn(turn, i, len(turns))
            rating = self.get_rating()
            
            if rating is None:  # User quit
                print("\n👋 Exiting...")
                return False
            
            if rating == 0:  # User skipped
                print("⏭️  Skipped")
                self.stats["turns_skipped"] += 1
            else:
                self.save_rated_turn(turn, rating)
                print(f"✅ Saved with rating {rating}")
        
        self.stats["sessions_processed"] += 1
        self.rated_sessions.add(session_id)
        return True
    
    def print_stats(self):
        """Print final statistics."""
        print(f"\n{'='*70}")
        print("📊 Rating Session Complete")
        print(f"{'='*70}")
        print(f"Sessions processed: {self.stats['sessions_processed']}")
        print(f"Turns rated:        {self.stats['turns_rated']}")
        print(f"Turns skipped:      {self.stats['turns_skipped']}")
        print(f"\nRating distribution:")
        for rating in range(5, 0, -1):
            count = self.stats["ratings"][rating]
            bar = "█" * count
            print(f"  {rating} ⭐ {count:3d}  {bar}")
        print(f"\n💾 Output: {self.output_file}")


def find_sessions(
    session_dir: Path,
    recent_days: Optional[int] = None,
    specific_session: Optional[Path] = None,
) -> List[Path]:
    """Find session files to process."""
    if specific_session:
        if not specific_session.exists():
            print(f"❌ Session file not found: {specific_session}")
            sys.exit(1)
        return [specific_session]
    
    if not session_dir.exists():
        print(f"❌ Session directory not found: {session_dir}")
        print("   No sessions to rate!")
        sys.exit(1)
    
    sessions = list(session_dir.rglob("*.jsonl"))
    
    if recent_days is not None:
        cutoff = datetime.now() - timedelta(days=recent_days)
        sessions = [
            s for s in sessions
            if datetime.fromtimestamp(s.stat().st_mtime) > cutoff
        ]
    
    # Sort by modification time (oldest first)
    sessions.sort(key=lambda s: s.stat().st_mtime)
    
    return sessions


def main():
    parser = argparse.ArgumentParser(
        description="Batch rate oh-my-pi session turns for fine-tuning datasets"
    )
    parser.add_argument(
        "--session-dir",
        type=Path,
        default=Path.home() / ".omp/agent/sessions",
        help="Directory containing session JSONL files (default: ~/.omp/agent/sessions)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.home() / ".omp/fine-tune-data/rated-turns.jsonl",
        help="Output file for rated turns (default: ~/.omp/fine-tune-data/rated-turns.jsonl)",
    )
    parser.add_argument(
        "--recent",
        type=int,
        metavar="DAYS",
        help="Only process sessions modified in last N days",
    )
    parser.add_argument(
        "--session",
        type=Path,
        metavar="PATH",
        help="Rate a specific session file",
    )
    parser.add_argument(
        "--context-turns",
        type=int,
        metavar="N",
        default=3,
        help="Number of prior turns to include as context (default: 3)",
    )
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="Don't skip already-rated sessions",
    )
    
    args = parser.parse_args()
    
    # Ensure output directory exists
    args.output.parent.mkdir(parents=True, exist_ok=True)
    
    # Find sessions to process
    sessions = find_sessions(args.session_dir, args.recent, args.session)
    
    if not sessions:
        print("ℹ️  No session files found")
        return
    
    print(f"🔍 Found {len(sessions)} session file(s)")
    
    if args.recent:
        print(f"   (from last {args.recent} days)")
    
    # Create rater and process sessions
    rater = SessionRater(
        args.output, 
        context_turns=args.context_turns,
        skip_rated=not args.no_resume
    )
    
    for session_file in sessions:
        if not rater.rate_session(session_file):
            break  # User quit
    
    # Print final statistics
    rater.print_stats()


if __name__ == "__main__":
    main()

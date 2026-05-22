#!/usr/bin/env python3
"""
Batch Rating Tool for oh-my-pi Sessions

Processes existing session JSONL files, extracts conversation turns,
and collects quality ratings for building fine-tuning datasets.

Usage:
    python scripts/rate-sessions.py                    # Rate all sessions
    python scripts/rate-sessions.py --recent 7         # Last 7 days only
    python scripts/rate-sessions.py --session <path>   # Rate specific session

Output:
    ~/.omp/fine-tune-data/rated-turns.jsonl
    
The output file contains one entry per rated turn:
    {
        "prompt": "...",
        "thinking": "..." | null,
        "response": "...",
        "rating": 1-5,
        "model": "...",
        "provider": "...",
        "session_id": "...",
        "timestamp": 1234567890
    }

Post-processing for training:
    - SFT: Filter rating >= 4, convert to {"messages": [...]}
    - DPO: Group by prompt, pair high/low ratings as chosen/rejected
"""

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional


class SessionRater:
    def __init__(self, output_file: Path, skip_rated: bool = True):
        self.output_file = output_file
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
    
    def extract_turns(self, messages: List[Dict[str, Any]], session_id: str) -> List[Dict[str, Any]]:
        """Extract user/assistant conversation turns."""
        turns = []
        last_user = None
        last_user_timestamp = None
        
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
                    last_user = text
                    last_user_timestamp = msg.get("timestamp")
            
            elif role == "assistant" and last_user:
                # Extract thinking blocks
                thinking_parts = []
                text_parts = []
                
                if isinstance(content, str):
                    text_parts.append(content)
                else:
                    for c in content:
                        if c.get("type") == "thinking":
                            thinking_parts.append(c.get("thinking", ""))
                        elif c.get("type") == "text":
                            text_parts.append(c.get("text", ""))
                
                thinking = "\n".join(thinking_parts) if thinking_parts else None
                response = "\n".join(text_parts)
                
                if response.strip():
                    turns.append({
                        "prompt": last_user,
                        "thinking": thinking,
                        "response": response,
                        "model": msg.get("model"),
                        "provider": msg.get("provider"),
                        "session_id": session_id,
                        "timestamp": msg.get("timestamp") or last_user_timestamp,
                    })
                
                last_user = None
                last_user_timestamp = None
        
        return turns
    
    def display_turn(self, turn: Dict[str, Any], index: int, total: int):
        """Display a turn for rating."""
        print(f"\n{'='*70}")
        print(f"Turn {index + 1}/{total}")
        print(f"{'='*70}")
        
        # User prompt
        prompt = turn["prompt"]
        prompt_preview = prompt[:500] + ("..." if len(prompt) > 500 else "")
        print(f"\n👤 USER ({len(prompt)} chars):")
        print(f"{prompt_preview}")
        
        # Thinking (if present)
        if turn["thinking"]:
            thinking = turn["thinking"]
            thinking_preview = thinking[:300] + ("..." if len(thinking) > 300 else "")
            print(f"\n🧠 THINKING ({len(thinking)} chars):")
            print(f"{thinking_preview}")
        
        # Assistant response
        response = turn["response"]
        response_preview = response[:500] + ("..." if len(response) > 500 else "")
        print(f"\n🤖 ASSISTANT ({len(response)} chars):")
        print(f"{response_preview}")
        
        # Metadata
        print(f"\n📊 Model: {turn['provider']}/{turn['model']}")
        if turn["timestamp"]:
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
            choice = input("Your rating: ").strip().lower()
            
            if choice == "q":
                return None
            if choice == "s":
                return 0
            if choice in "12345":
                return int(choice)
            
            print("❌ Invalid input! Use 1-5, s, or q")
    
    def save_rated_turn(self, turn: Dict[str, Any], rating: int):
        """Append rated turn to output file."""
        entry = {
            "prompt": turn["prompt"],
            "thinking": turn["thinking"],
            "response": turn["response"],
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
        
        turns = self.extract_turns(messages, session_id)
        
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
    rater = SessionRater(args.output, skip_rated=not args.no_resume)
    
    for session_file in sessions:
        if not rater.rate_session(session_file):
            break  # User quit
    
    # Print final statistics
    rater.print_stats()


if __name__ == "__main__":
    main()

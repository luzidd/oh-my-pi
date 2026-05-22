#!/usr/bin/env python3
"""
Convert rated conversations to training formats (SFT and DPO).

Takes the output from rate-sessions.py and converts it to formats
suitable for fine-tuning with Unsloth, TRL, or other training libraries.

Usage:
    python scripts/convert-to-training-format.py

Input:
    ~/.omp/fine-tune-data/rated-turns.jsonl
    
    Format:
        {
            "messages": [
                {"role": "user", "content": "..."},
                {"role": "assistant", "content": "<thinking>...</thinking>..."}
            ],
            "rating": 5,
            "model": "...",
            "provider": "..."
        }

Output:
    ~/.omp/fine-tune-data/sft-dataset.jsonl     # SFT format (rating >= 4)
    ~/.omp/fine-tune-data/dpo-dataset.jsonl     # DPO format (paired comparisons)
"""

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List


def load_rated_turns(input_file: Path) -> List[Dict[str, Any]]:
    """Load all rated turns from JSONL file."""
    turns = []
    
    if not input_file.exists():
        print(f"❌ Input file not found: {input_file}")
        return []
    
    with open(input_file) as f:
        for line in f:
            turns.append(json.loads(line))
    
    return turns


def convert_to_sft(turns: List[Dict[str, Any]], min_rating: int = 4) -> List[Dict[str, Any]]:
    """
    Convert to SFT format: standard chat messages with context.
    
    Format:
        {
            "messages": [
                {"role": "user", "content": "..."},
                {"role": "assistant", "content": "..."},
                {"role": "user", "content": "..."},
                {"role": "assistant", "content": "<thinking>...</thinking>..."}
            ],
            "rating": 5,
            "model": "...",
            "provider": "..."
        }
    
    Training objective: The model learns to predict the last assistant message
    given all prior messages as context.
    """
    sft_entries = []
    
    for turn in turns:
        if turn["rating"] < min_rating:
            continue
        
        # Pass through the messages array directly
        entry = {
            "messages": turn["messages"],
            "rating": turn["rating"],
            "model": turn["model"],
            "provider": turn["provider"],
        }
        
        sft_entries.append(entry)
    
    return sft_entries


def convert_to_dpo(turns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Convert to DPO format: preference pairs.
    
    Groups conversations by context (all messages except the last assistant response),
    creates chosen/rejected pairs where higher-rated response = chosen,
    lower-rated = rejected.
    
    Format:
        {
            "messages": [
                {"role": "user", "content": "..."},   # Context
                {"role": "assistant", "content": "..."}  # Context
            ],
            "chosen": "<thinking>...</thinking>...",    # Higher-rated response
            "rejected": "...",                          # Lower-rated response
            "chosen_rating": 5,
            "rejected_rating": 2
        }
    
    Training objective: The model learns to prefer chosen over rejected
    given the same conversation context.
    """
    # Group by conversation context (all messages except last assistant)
    context_groups = defaultdict(list)
    
    for turn in turns:
        messages = turn["messages"]
        # Context = all messages except the last assistant response
        context = messages[:-1]
        # Last assistant response is what we're comparing
        response = messages[-1]["content"]
        
        # Create a key from the context (serialize to JSON for hashing)
        context_key = json.dumps(context, sort_keys=True)
        
        context_groups[context_key].append({
            "context": context,
            "response": response,
            "rating": turn["rating"],
        })
    
    dpo_entries = []
    
    for context_key, responses in context_groups.items():
        # Need at least 2 responses for comparison
        if len(responses) < 2:
            continue
        
        # Sort by rating (descending)
        responses.sort(key=lambda r: r["rating"], reverse=True)
        
        # Create pairs: higher-rated vs lower-rated
        for i in range(len(responses) - 1):
            chosen = responses[i]
            for j in range(i + 1, len(responses)):
                rejected = responses[j]
                
                # Only create pair if there's a rating difference
                if chosen["rating"] <= rejected["rating"]:
                    continue
                
                entry = {
                    "messages": chosen["context"],  # Shared context
                    "chosen": chosen["response"],
                    "rejected": rejected["response"],
                    "chosen_rating": chosen["rating"],
                    "rejected_rating": rejected["rating"],
                }
                
                dpo_entries.append(entry)
    
    return dpo_entries


def save_dataset(entries: List[Dict[str, Any]], output_file: Path, name: str):
    """Save dataset to JSONL file."""
    if not entries:
        print(f"⚠️  No {name} entries to save")
        return
    
    with open(output_file, "w") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")
    
    print(f"✅ Saved {len(entries)} {name} entries to {output_file}")


def print_stats(sft_entries: List[Dict], dpo_entries: List[Dict]):
    """Print conversion statistics."""
    print(f"\n{'='*70}")
    print("📊 Conversion Statistics")
    print(f"{'='*70}")
    
    print(f"\nSFT Dataset:")
    print(f"  Total examples: {len(sft_entries)}")
    if sft_entries:
        ratings = [e["rating"] for e in sft_entries]
        avg_rating = sum(ratings) / len(ratings)
        print(f"  Average rating: {avg_rating:.2f}")
        print(f"  Rating 5: {ratings.count(5)}")
        print(f"  Rating 4: {ratings.count(4)}")
    
    print(f"\nDPO Dataset:")
    print(f"  Total pairs: {len(dpo_entries)}")
    if dpo_entries:
        avg_diff = sum(e["chosen_rating"] - e["rejected_rating"] for e in dpo_entries) / len(dpo_entries)
        print(f"  Average rating difference: {avg_diff:.2f}")
        
        # Count by rating difference
        diff_counts = defaultdict(int)
        for e in dpo_entries:
            diff = e["chosen_rating"] - e["rejected_rating"]
            diff_counts[diff] += 1
        
        print(f"  Rating differences:")
        for diff in sorted(diff_counts.keys(), reverse=True):
            print(f"    {diff} stars: {diff_counts[diff]} pairs")


def main():
    # File paths
    input_file = Path.home() / ".omp/fine-tune-data/rated-turns.jsonl"
    sft_output = Path.home() / ".omp/fine-tune-data/sft-dataset.jsonl"
    dpo_output = Path.home() / ".omp/fine-tune-data/dpo-dataset.jsonl"
    
    print("🔄 Converting rated turns to training formats...")
    print(f"📂 Input: {input_file}")
    
    # Load rated turns
    turns = load_rated_turns(input_file)
    
    if not turns:
        print("❌ No rated turns found!")
        return
    
    print(f"📊 Loaded {len(turns)} rated turns")
    
    # Convert to SFT format (rating >= 4)
    print("\n🔄 Converting to SFT format (rating >= 4)...")
    sft_entries = convert_to_sft(turns, min_rating=4)
    save_dataset(sft_entries, sft_output, "SFT")
    
    # Convert to DPO format
    print("\n🔄 Converting to DPO format (preference pairs)...")
    dpo_entries = convert_to_dpo(turns)
    save_dataset(dpo_entries, dpo_output, "DPO")
    
    # Print statistics
    print_stats(sft_entries, dpo_entries)
    
    print(f"\n{'='*70}")
    print("✅ Conversion complete!")
    print(f"{'='*70}")
    print("\nNext steps:")
    print(f"  1. Review datasets: {sft_output.parent}")
    print("  2. Use with Unsloth/TRL for training")
    print("\nExample Unsloth SFT:")
    print("  from unsloth import FastLanguageModel")
    print("  from datasets import load_dataset")
    print("  dataset = load_dataset('json', data_files='sft-dataset.jsonl')")


if __name__ == "__main__":
    main()

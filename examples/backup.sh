#!/usr/bin/env bash
# Copies a report into the backup folder, clearing out any half-finished copy first.
# It has two bugs. Both are invisible here and obvious in bashle.

# @probe "reports/Q3 report.txt" => exit 0
file=$1
backup_dir=backup

rm -rf "$backup_dir/partial"
mkdir -p "$backup_dir"
cp "$file" "$backup_dir/"
echo "backed up $file"

#!/usr/bin/env bash
# Shared by the scripts that pass CLI words to "gcloud run jobs execute --args" (infra/catalog-eval.sh,
# infra/catalog-output-evals.sh). Source it; it defines functions only.

# Builds the --args value for "gcloud run jobs execute" from the CLI words.
# gcloud treats --args as a set: it refuses any value that appears twice, both on the command line and
# in a --flags-file list (UpdateAction in googlecloudsdk/calliope/arg_parsers.py), so
# "--sample 1 --seed 1" (catalog-eval) failed with '"1" cannot be specified multiple times'. Each "--flag value"
# pair is therefore folded into one "--flag=value" token (the CLI reads both forms, with the same
# rule: a flag takes the next token unless it is missing or is itself a flag), which keeps every token
# of a valid command line unique. gcloud list escaping (gcloud topic escaping): "^|^" makes "|" the
# separator, so model lists such as "a,b" stay one argument.
cli_args() {
  local argv=("$@") tokens=() i=0 a next joined dup
  while [ "$i" -lt "${#argv[@]}" ]; do
    a=${argv[$i]}; next=${argv[$((i + 1))]-}
    if [[ $a == --* && $a != *=* && $((i + 1)) -lt ${#argv[@]} && $next != --* ]]; then
      tokens+=("$a=$next"); i=$((i + 2))
    else
      tokens+=("$a"); i=$((i + 1))
    fi
  done
  for a in "${tokens[@]}"; do
    case "$a" in *"|"*) echo "ERROR: an argument contains '|', which this script uses as the gcloud list separator: $a" >&2; return 1 ;; esac
  done
  dup=$(printf '%s\n' "${tokens[@]}" | sort | uniq -d | head -n 1)
  if [ -n "$dup" ]; then
    echo "ERROR: the argument $dup is given twice; gcloud run jobs execute cannot pass a repeated argument. Remove the repeat." >&2
    return 1
  fi
  joined=$(printf '%s|' "${tokens[@]}")
  printf '%s' "^|^${joined%|}"
}

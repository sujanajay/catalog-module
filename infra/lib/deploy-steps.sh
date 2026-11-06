# M6-F2 (M6-S5): the deploy report, the duration of every step of infra/deploy.sh, and the final DEPLOY_OK line (F2
# acceptance test 3 measures from the start of deploy.sh to DEPLOY_OK). Sourced first by deploy.sh; pure bash.
#   deploy_step <name>   ends the step that ran so far and starts <name>
#   deploy_report <tag>  ends the last step, prints each step's minutes and seconds, any notes the gates left in
#                        DEPLOY_NOTES_FILE, then "DEPLOY_OK <tag> in <m>m<s>s"
# Tests set DEPLOY_CLOCK to a command that prints the seconds now.

DEPLOY_STEP_NAME=""
DEPLOY_STEP_STARTED=0
DEPLOY_STEP_LINES=()
DEPLOY_NOTES_FILE=$(mktemp)

deploy_clock() { if [ -n "${DEPLOY_CLOCK:-}" ]; then $DEPLOY_CLOCK; else echo "$SECONDS"; fi; }
DEPLOY_STARTED=$(deploy_clock)

deploy_duration() { printf '%dm%02ds' "$(($1 / 60))" "$(($1 % 60))"; }

deploy_step() {
  local now
  now=$(deploy_clock)
  if [ -n "$DEPLOY_STEP_NAME" ]; then DEPLOY_STEP_LINES+=("$(deploy_duration $((now - DEPLOY_STEP_STARTED)))  $DEPLOY_STEP_NAME"); fi
  DEPLOY_STEP_NAME=$1
  DEPLOY_STEP_STARTED=$now
}

deploy_report() {
  local line now
  deploy_step ""
  now=$(deploy_clock)
  echo "==> deploy report (minutes and seconds per step)"
  for line in "${DEPLOY_STEP_LINES[@]}"; do echo "    $line"; done
  if [ -s "$DEPLOY_NOTES_FILE" ]; then
    echo "==> passed with an unexplained 502 (cause unknown; read the candidate's logs for that call)"
    sed 's/^/    /' "$DEPLOY_NOTES_FILE"
  fi
  rm -f "$DEPLOY_NOTES_FILE"
  echo "DEPLOY_OK $1 in $(deploy_duration $((now - DEPLOY_STARTED)))"
}

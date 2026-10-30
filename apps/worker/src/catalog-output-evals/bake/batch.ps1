$models = "swinir-x2,general-x4v3-d10,general-x4v3-d05,general-x4v3-d00,realesrgan-x2plus,realesrgan-x4plus,realesrnet-x4plus"
foreach ($k in $args) {
  $t = Get-Date
  & Q:\venv\Scripts\python.exe -I Q:\scripts\driver.py $k $models 2>&1 | Out-File -Append -Encoding ascii Q:\out\batch.log
  "$k done in $([int]((Get-Date) - $t).TotalSeconds) s" | Out-File -Append -Encoding ascii Q:\out\progress.log
}
"ALL DONE" | Out-File -Append -Encoding ascii Q:\out\progress.log

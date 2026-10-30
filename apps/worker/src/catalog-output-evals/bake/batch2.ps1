$jobs = @(
  @("t24", "swinir-x2,swinir-x4", "2.0,2.5,3.5"),
  @("z3cb1", "swinir-x2,swinir-x4", "2.0,2.5,3.5"),
  @("uspa1", "swinir-x2,swinir-x4", "2.0,2.5,3.5"),
  @("hcb209", "swinir-x2,swinir-x4", "2.0,2.5,3.5"),
  @("t30", "swinir-x2,swinir-x4,realesrnet-x4plus,general-x4v3-d05", "1.2,1.5,2.0,2.5,3.5"),
  @("img3", "swinir-x2,swinir-x4,general-x4v3-d05,general-x4v3-d00", "1.2,1.5,2.0,2.5,3.5")
)
foreach ($j in $jobs) {
  $t = Get-Date
  & Q:\venv\Scripts\python.exe -I Q:\scripts\driver.py $j[0] $j[1] $j[2] 2>&1 | Out-File -Append -Encoding ascii Q:\out\batch.log
  "$($j[0]) done in $([int]((Get-Date) - $t).TotalSeconds) s" | Out-File -Append -Encoding ascii Q:\out\progress.log
}
"ALL DONE" | Out-File -Append -Encoding ascii Q:\out\progress.log

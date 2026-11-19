# Toolchain for the factory's CI jobs on GitLab CI and Azure Pipelines: installs what this codebase needs to
# build and run its test stack on a runner (SDKs, package restore, browsers). The lint and demo video jobs
# source it (`. .factory/ci/toolchain.sh`) before they run, so exported variables and PATH changes stay.
# This file is yours: `factory init` wrote it once and never touches it again. (GitHub Actions uses
# .github/actions/factory-toolchain/action.yml instead.)
#
# Examples: apt-get install -y openjdk-21-jdk; curl -sSf https://sh.rustup.rs | sh -s -- -y; then your
# restore or install command.
echo "No toolchain steps yet. Edit .factory/ci/toolchain.sh."

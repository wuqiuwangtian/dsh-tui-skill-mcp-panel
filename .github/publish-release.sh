#!/usr/bin/env bash
# Run on GitHub's hosted runner after the read-only verification job.
set -euo pipefail

package=dsh-tui-skill-mcp-panel
tag="v$VERSION"
file="$package-$VERSION.tgz"
archive="release-output/$file"
notes="release-output/notes.md"
registry="https://registry.npmjs.org/$package/$VERSION"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

[[ "$GITHUB_REF" = refs/heads/main && "$GITHUB_SHA" = "$REVIEWED_COMMIT" ]]
[[ "$(git rev-parse HEAD)" = "$REVIEWED_COMMIT" ]]
echo "$EXPECTED_SHA256  $archive" | sha256sum --check
cmp "$notes" "docs/releases/$tag.md"

# A partially completed run can already have a lightweight or annotated tag.
tag_refs=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")
if [[ -n "$tag_refs" ]]; then
  git fetch --no-tags origin "refs/tags/$tag"
  test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$REVIEWED_COMMIT"
fi

status=$(curl --silent --show-error --output "$scratch/meta.json" --write-out '%{http_code}' "$registry")
case "$status" in
  200) echo "Version already exists. Verifying the registry copy before resuming." ;;
  404)
    if [[ -n "${NODE_AUTH_TOKEN:-}" ]]; then
      # Initial package bootstrap. Keep the token out of logs and the checkout.
      export NPM_CONFIG_USERCONFIG="$scratch/npmrc"
      printf '%s\n' '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}' > "$NPM_CONFIG_USERCONFIG"
      chmod 600 "$NPM_CONFIG_USERCONFIG"
    fi
    npm publish "./$archive" --ignore-scripts --registry=https://registry.npmjs.org/ --access public --provenance
    ;;
  *) echo "Registry returned HTTP $status" >&2; exit 1 ;;
esac

# Confirm provenance metadata and download over the public, unauthenticated path.
curl -fsS --retry 5 --retry-all-errors "$registry" -o "$scratch/meta.json"
tarball_url="https://registry.npmjs.org/$package/-/$file"
jq --exit-status --arg url "$tarball_url" --arg version "$VERSION" --arg name "$package" \
  '.name == $name and .version == $version and .dist.tarball == $url and (.dist.attestations.provenance.predicateType | startswith("https://slsa.dev/provenance/"))' \
  "$scratch/meta.json" > /dev/null
curl -fsS --retry 5 --retry-all-errors "$tarball_url" -o "$scratch/npm.tgz"
cmp "$archive" "$scratch/npm.tgz"
attestations="https://registry.npmjs.org/-/npm/v1/attestations/$package@$VERSION"
curl -fsS --retry 5 --retry-all-errors "$attestations" -o "$scratch/attestations.json"
sha512=$(sha512sum "$archive" | cut -d' ' -f1)
jq --exit-status --arg repository "https://github.com/$GITHUB_REPOSITORY" \
  --arg commit "$REVIEWED_COMMIT" --arg sha512 "$sha512" '
  any(.attestations[] | select(.predicateType == "https://slsa.dev/provenance/v1")
      | .bundle.dsseEnvelope.payload | @base64d | fromjson;
    any(.subject[]; .digest.sha512 == $sha512)
    and (.predicate.buildDefinition | .externalParameters.workflow == {
      repository: $repository, path: ".github/workflows/release.yml", ref: "refs/heads/main"
    } and any(.resolvedDependencies[]; .digest.gitCommit == $commit)))' \
  "$scratch/attestations.json" > /dev/null

# Prepare the attachment in a draft. A retry must recover uploaded bytes or fail
# on a collision. Never replace an existing asset or move a tag.
if ! gh release view "$tag" --json isDraft,assets,targetCommitish > "$scratch/release.json"; then
  gh release create "$tag" --draft --target "$REVIEWED_COMMIT" --title "$tag" --notes-file "$notes"
  gh release view "$tag" --json isDraft,assets,targetCommitish > "$scratch/release.json"
fi
if [[ -z "$tag_refs" ]]; then
  test "$(jq -r .targetCommitish "$scratch/release.json")" = "$REVIEWED_COMMIT"
fi
if ! jq --exit-status --arg name "$file" 'any(.assets[]; .name == $name)' "$scratch/release.json" > /dev/null; then
  test "$(jq -r .isDraft "$scratch/release.json")" = true
  gh release upload "$tag" "$archive"
fi
gh release download "$tag" --pattern "$file" --dir "$scratch"
cmp "$archive" "$scratch/$file"
if [[ "$(jq -r .isDraft "$scratch/release.json")" = true ]]; then
  gh release edit "$tag" --draft=false
fi
git fetch --no-tags origin "refs/tags/$tag"
test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$REVIEWED_COMMIT"
test "$(gh release view "$tag" --json isDraft --jq .isDraft)" = false
gh release view "$tag" --json url --jq .url

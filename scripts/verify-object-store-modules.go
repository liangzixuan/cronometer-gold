// Native build gate. Uses only the pinned Go toolchain and its standard library.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type reviewedModule struct {
	Path, Version, Sum, GoModSum, PublishedAt string
	ZipFileSha256, LicenseArchivePath, LicenseSha256 string
}
type replacement struct { Path, ReplacementPath, ReplacementVersion string }
type moduleLock struct {
	GoModSha256, GoSumSha256 string
	ReviewedModules []reviewedModule
	AllowedReplacements []replacement
	ExpectedSelectedVersions map[string]string
}
type moduleRecord struct {
	Path, Version, Sum, GoModSum, Zip, Info string
	Main bool
	Replace *moduleRecord
	Error json.RawMessage
}

func hash(data []byte) string { value := sha256.Sum256(data); return hex.EncodeToString(value[:]) }
func read(path string) ([]byte, error) { return os.ReadFile(path) }
func inputs(lock moduleLock, mod, sum []byte) error {
	if hash(mod) != lock.GoModSha256 || hash(sum) != lock.GoSumSha256 {
		return fmt.Errorf("frozen Go inputs changed")
	}
	return nil
}
func records(data []byte) ([]moduleRecord, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var result []moduleRecord
	for {
		var value moduleRecord
		if err := decoder.Decode(&value); err != nil {
			if err == io.EOF { return result, nil }
			return nil, err
		}
		if len(value.Error) > 0 && string(value.Error) != "null" { return nil, fmt.Errorf("Go reported an error for %s", value.Path) }
		result = append(result, value)
	}
}
func graph(lock moduleLock, sums []byte, modules []moduleRecord) error {
	knownSums := map[string]string{}
	for _, line := range strings.Split(string(sums), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 { knownSums[fields[0]+"@"+fields[1]] = fields[2] }
	}
	seen := map[string]bool{}
	mainCount := 0
	for _, item := range modules {
		if item.Main {
			if item.Path != "github.com/seaweedfs/seaweedfs" || item.Replace != nil { return fmt.Errorf("unexpected main module") }
			mainCount++
			continue
		}
		if seen[item.Path] || lock.ExpectedSelectedVersions[item.Path] != item.Version || item.Version == "" {
			return fmt.Errorf("unreviewed, duplicate or moved module: %s@%s", item.Path, item.Version)
		}
		seen[item.Path] = true
		actual := item
		var expected *replacement
		for i := range lock.AllowedReplacements {
			if lock.AllowedReplacements[i].Path == item.Path { expected = &lock.AllowedReplacements[i] }
		}
		if expected != nil {
			if item.Replace == nil || item.Replace.Path != expected.ReplacementPath || item.Replace.Version != expected.ReplacementVersion || item.Replace.Replace != nil {
				return fmt.Errorf("upstream replacement changed: %s", item.Path)
			}
			actual = *item.Replace
		} else if item.Replace != nil { return fmt.Errorf("unreviewed replacement: %s", item.Path) }
		if actual.Sum == "" || actual.GoModSum == "" || knownSums[actual.Path+"@"+actual.Version] != actual.Sum || knownSums[actual.Path+"@"+actual.Version+"/go.mod"] != actual.GoModSum {
			return fmt.Errorf("module checksums differ from frozen inputs: %s", actual.Path)
		}
	}
	if mainCount != 1 || len(seen) != len(lock.ExpectedSelectedVersions) { return fmt.Errorf("resolved graph is incomplete") }
	return nil
}
func downloaded(expected reviewedModule, actual moduleRecord) error {
	if actual.Path != expected.Path || actual.Version != expected.Version || actual.Sum != expected.Sum || actual.GoModSum != expected.GoModSum || actual.Replace != nil {
		return fmt.Errorf("authenticated sums differ: %s", expected.Path)
	}
	published, err := time.Parse(time.RFC3339, expected.PublishedAt)
	if err != nil || time.Since(published) < 24*time.Hour { return fmt.Errorf("module release age is under 24 hours: %s", expected.Path) }
	data, err := read(actual.Info); if err != nil { return err }
	var info struct { Time time.Time }
	if err = json.Unmarshal(data, &info); err != nil || !info.Time.Equal(published) { return fmt.Errorf("module release time differs: %s", expected.Path) }
	data, err = read(actual.Zip); if err != nil { return err }
	if hash(data) != expected.ZipFileSha256 { return fmt.Errorf("module archive bytes differ: %s", expected.Path) }
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data))); if err != nil { return err }
	for _, entry := range archive.File {
		if entry.Name != expected.LicenseArchivePath { continue }
		stream, err := entry.Open(); if err != nil { return err }
		license, err := io.ReadAll(io.LimitReader(stream, 1024*1024)); stream.Close()
		if err != nil || hash(license) != expected.LicenseSha256 { return fmt.Errorf("reviewed license differs: %s", expected.Path) }
		return nil
	}
	return fmt.Errorf("reviewed license missing: %s", expected.Path)
}
func authenticate(lock moduleLock) error {
	// An empty working directory and module cache force Go's signed checksum-log
	// validation. Prefilled reviewed go.sum entries alone would not prove it.
	dir, err := os.MkdirTemp("", "object-store-sumdb-"); if err != nil { return err }
	defer os.RemoveAll(dir)
	args := []string{"mod", "download", "-json"}
	for _, item := range lock.ReviewedModules { args = append(args, item.Path+"@"+item.Version) }
	command := exec.Command("go", args...)
	command.Dir = dir
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "GOMODCACHE=") && !strings.HasPrefix(item, "GO111MODULE=") { command.Env = append(command.Env, item) }
	}
	command.Env = append(command.Env, "GOMODCACHE="+filepath.Join(dir,"cache"), "GO111MODULE=on")
	command.Stderr = os.Stderr
	data, err := command.Output(); if err != nil { return err }
	items, err := records(data); if err != nil { return err }
	if len(items) != len(lock.ReviewedModules) || len(items) == 0 { return fmt.Errorf("incomplete checksum-log authentication") }
	seen := map[string]bool{}
	for _, actual := range items {
		key := actual.Path+"@"+actual.Version
		if seen[key] { return fmt.Errorf("duplicate authenticated module") }; seen[key] = true
		found := false
		for _, expected := range lock.ReviewedModules {
			if expected.Path == actual.Path && expected.Version == actual.Version {
				if err := downloaded(expected, actual); err != nil { return err }
				found = true
			}
		}
		if !found { return fmt.Errorf("unexpected authenticated module") }
	}
	return nil
}
func run(args []string) error {
	if len(args) < 2 { return fmt.Errorf("expected mode and module lock") }
	data, err := read(args[1]); if err != nil { return err }
	var lock moduleLock
	if err = json.Unmarshal(data, &lock); err != nil { return err }
	if len(lock.ExpectedSelectedVersions) == 0 || len(lock.ReviewedModules) == 0 { return fmt.Errorf("empty module lock") }
	switch args[0] {
	case "authenticate":
		if len(args) != 2 { return fmt.Errorf("unexpected arguments") }; return authenticate(lock)
	case "inputs":
		if len(args) != 4 { return fmt.Errorf("expected go.mod and go.sum") }
		mod, err := read(args[2]); if err != nil { return err }; sum, err := read(args[3]); if err != nil { return err }
		return inputs(lock, mod, sum)
	case "graph":
		if len(args) != 4 { return fmt.Errorf("expected go.sum and graph") }
		sum, err := read(args[2]); if err != nil { return err }; raw, err := read(args[3]); if err != nil { return err }
		items, err := records(raw); if err != nil { return err }; return graph(lock, sum, items)
	default: return fmt.Errorf("unknown verification mode")
	}
}
func main() { if err := run(os.Args[1:]); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) } }

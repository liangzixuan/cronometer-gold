package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)
func TestFrozenInputs(t *testing.T) {
	lock := moduleLock{GoModSha256:hash([]byte("mod")),GoSumSha256:hash([]byte("sum"))}
	if err:=inputs(lock,[]byte("mod"),[]byte("sum")); err!=nil {t.Fatal(err)}
	if err:=inputs(lock,[]byte("modified"),[]byte("sum")); err==nil {t.Fatal("accepted changed inputs")}
}
func TestGraph(t *testing.T) {
	base:=func() (moduleLock,[]moduleRecord) {
		return moduleLock{ExpectedSelectedVersions:map[string]string{"example.test/module":"v1.0.0"}},
		[]moduleRecord{{Path:"github.com/seaweedfs/seaweedfs",Main:true},{Path:"example.test/module",Version:"v1.0.0",Sum:"h1:content",GoModSum:"h1:mod"}}
	}
	sums:=[]byte("example.test/module v1.0.0 h1:content\nexample.test/module v1.0.0/go.mod h1:mod\n")
	lock,modules:=base(); if err:=graph(lock,sums,modules); err!=nil {t.Fatal(err)}
	tests:=map[string]func(*moduleLock,*[]moduleRecord){
		"moved":func(_ *moduleLock,m *[]moduleRecord){(*m)[1].Version="v2.0.0"},
		"unknown":func(_ *moduleLock,m *[]moduleRecord){(*m)[1].Path="unreviewed.test/module"},
		"missing":func(_ *moduleLock,m *[]moduleRecord){*m=(*m)[:1]},
		"duplicate":func(_ *moduleLock,m *[]moduleRecord){*m=append(*m,(*m)[1])},
		"content":func(_ *moduleLock,m *[]moduleRecord){(*m)[1].Sum="h1:wrong"},
		"modsum":func(_ *moduleLock,m *[]moduleRecord){(*m)[1].GoModSum="h1:wrong"},
		"replacement":func(_ *moduleLock,m *[]moduleRecord){(*m)[1].Replace=&moduleRecord{Path:"other",Version:"v1.0.0"}},
	}
	for name,change:=range tests {t.Run(name,func(t *testing.T){lock,modules:=base();change(&lock,&modules);if err:=graph(lock,sums,modules);err==nil{t.Fatal("accepted invalid graph")}})}
	lock,modules=base()
	lock.AllowedReplacements=[]replacement{{Path:"example.test/module",ReplacementPath:"reviewed.test/fork",ReplacementVersion:"v1.0.0"}}
	modules[1].Replace=&moduleRecord{Path:"reviewed.test/fork",Version:"v1.0.0",Sum:"h1:content",GoModSum:"h1:mod"}
	forkSums:=[]byte("reviewed.test/fork v1.0.0 h1:content\nreviewed.test/fork v1.0.0/go.mod h1:mod\n")
	if err:=graph(lock,forkSums,modules);err!=nil{t.Fatal(err)}
	modules[1].Replace.Version="v2.0.0";if err:=graph(lock,forkSums,modules);err==nil{t.Fatal("accepted changed replacement")}
}
func TestRecordErrors(t *testing.T) {
	for _,raw:=range []string{`{"Path":"x","Error":"failed"}`,`{"Path":"x","Error":{"Err":"failed"}}`,`{"Path":`} {
		if _,err:=records([]byte(raw));err==nil{t.Fatal("accepted malformed Go output")}
	}
	if _,err:=records([]byte(`{"Path":"x"} {"Path":"y"}`));err!=nil{t.Fatal(err)}
}


func TestAuthenticatedModuleContent(t *testing.T) {
	dir := t.TempDir()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	license, err := writer.Create("example.test/module@v1.0.0/LICENSE")
	if err != nil { t.Fatal(err) }
	if _, err = license.Write([]byte("reviewed license")); err != nil { t.Fatal(err) }
	if err = writer.Close(); err != nil { t.Fatal(err) }
	zipPath := filepath.Join(dir, "module.zip")
	infoPath := filepath.Join(dir, "module.info")
	if err = os.WriteFile(zipPath, buffer.Bytes(), 0600); err != nil { t.Fatal(err) }
	published := time.Now().UTC().Add(-48*time.Hour).Truncate(time.Second).Format(time.RFC3339)
	if err = os.WriteFile(infoPath, []byte("{\"Time\":\""+published+"\"}"), 0600); err != nil { t.Fatal(err) }
	expected := reviewedModule{Path:"example.test/module", Version:"v1.0.0", Sum:"h1:content", GoModSum:"h1:mod",
		PublishedAt:published, ZipFileSha256:hash(buffer.Bytes()), LicenseArchivePath:"example.test/module@v1.0.0/LICENSE",
		LicenseSha256:hash([]byte("reviewed license"))}
	actual := moduleRecord{Path:expected.Path, Version:expected.Version, Sum:expected.Sum, GoModSum:expected.GoModSum, Zip:zipPath, Info:infoPath}
	if err := downloaded(expected, actual); err != nil { t.Fatal(err) }
	for name, change := range map[string]func(*reviewedModule){
		"license":func(m *reviewedModule){m.LicenseSha256=hash([]byte("different"))},
		"missing-license":func(m *reviewedModule){m.LicenseArchivePath="missing"},
		"archive":func(m *reviewedModule){m.ZipFileSha256=hash([]byte("different"))},
		"content":func(m *reviewedModule){m.Sum="h1:different"},
		"module-file":func(m *reviewedModule){m.GoModSum="h1:different"},
		"age":func(m *reviewedModule){m.PublishedAt=time.Now().UTC().Format(time.RFC3339)},
	} {
		t.Run(name, func(t *testing.T){changed:=expected;change(&changed);if err:=downloaded(changed,actual);err==nil{t.Fatal("accepted invalid authenticated module")}})
	}
}

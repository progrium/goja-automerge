package objpath

import (
	"strconv"
	"strings"

	automerge "github.com/progrium/goja-automerge"
)

func Get(root *automerge.Object, path string) interface{} {
	parts := strings.Split(strings.TrimLeft(path, "/"), "/")
	obj := root
	for _, part := range parts {
		obj = obj.Get(part)
	}
	if obj == nil {
		return nil
	}
	return obj.Export()
}

func Put(root *automerge.Object, path string, v interface{}) error {
	parts := strings.Split(strings.TrimLeft(path, "/"), "/")
	obj := root
	last := parts[len(parts)-1]
	for _, part := range parts[:len(parts)-1] {
		obj = obj.Get(part)
	}
	return obj.Set(last, v)
}

func Delete(root *automerge.Object, path string) error {
	parts := strings.Split(strings.TrimLeft(path, "/"), "/")
	obj := root
	key := parts[len(parts)-1]
	var prev *automerge.Object
	for _, part := range parts[:len(parts)-1] {
		prev = obj
		obj = obj.Get(part)
	}
	idx, err := strconv.Atoi(key)
	if err != nil {
		return obj.Delete(key)
	}
	obj.Call("splice", idx, 1)
	return prev.Set(parts[len(parts)-2], obj)
}

func Insert(root *automerge.Object, path string, v interface{}) error {
	parts := strings.Split(strings.TrimLeft(path, "/"), "/")
	obj := root
	key := parts[len(parts)-1]
	var prev *automerge.Object
	for _, part := range parts[:len(parts)-1] {
		prev = obj
		obj = obj.Get(part)
	}
	if key == "" {
		// path ends in / so push onto obj
		obj.Call("push", v)
		return prev.Set(parts[len(parts)-2], obj)
	}
	idx, err := strconv.Atoi(key)
	if err != nil {
		return err
	}
	obj.Call("splice", idx, 0, v)
	return prev.Set(parts[len(parts)-2], obj)
}

func Call(root *automerge.Object, path string, args ...interface{}) interface{} {
	parts := strings.Split(strings.TrimLeft(path, "/"), "/")
	obj := root
	method := parts[len(parts)-1]
	for _, part := range parts[:len(parts)-1] {
		obj = obj.Get(part)
	}
	return obj.Call(method, args...).Export()
}

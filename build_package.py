import shutil
import os
import sys

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(BASE_DIR, "extension")
DIST_DIR = os.path.join(BASE_DIR, "dist")

def clean_dist():
    if os.path.exists(DIST_DIR):
        print(f"Cleaning {DIST_DIR}...")
        shutil.rmtree(DIST_DIR)
    os.makedirs(DIST_DIR)

def build_target(target_name, manifest_name):
    target_dir = os.path.join(DIST_DIR, target_name)
    print(f"Building {target_name} extension in {target_dir}...")
    
    # 1. Copy everything from source
    shutil.copytree(SRC_DIR, target_dir)
    
    # 2. Overwrite manifest.json with the target version
    manifest_src = os.path.join(target_dir, manifest_name)
    manifest_dest = os.path.join(target_dir, "manifest.json")
    
    if os.path.exists(manifest_src):
        if os.path.exists(manifest_dest):
            os.remove(manifest_dest)
        os.rename(manifest_src, manifest_dest)
        print(f"  - Applied {manifest_name}")
    else:
        print(f"  - ERROR: {manifest_name} not found!")

    # 3. Cleanup other manifest files from the build
    for f in os.listdir(target_dir):
        if f.startswith("manifest") and f.endswith(".json") and f != "manifest.json":
            os.remove(os.path.join(target_dir, f))
    
    print(f"  - {target_name} build complete.")

if __name__ == "__main__":
    clean_dist()
    build_target("chrome", "manifest-chrome.json")
    build_target("firefox", "manifest-firefox.json")
    
    print("\nBuild Complete!")
    print(f"Chrome Extension:  {os.path.join(DIST_DIR, 'chrome')}")
    print(f"Firefox Extension: {os.path.join(DIST_DIR, 'firefox')}")

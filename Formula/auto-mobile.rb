class AutoMobile < Formula
  desc "Mobile device interaction automation via MCP"
  homepage "https://kaeawc.github.io/auto-mobile/"
  url "https://registry.npmjs.org/@kaeawc/auto-mobile/-/auto-mobile-0.0.26.tgz"
  sha256 "c8255eb157341f3f1ca4928644dda341816d6cbe94f3a73c303a26215b5be93c"
  license "Apache-2.0"

  depends_on "bun"

  def install
    libexec.install Dir["*"]
    (bin/"auto-mobile").write <<~SH
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/dist/src/index.js" "$@"
    SH
    chmod 0755, bin/"auto-mobile"
  end

  test do
    output = shell_output("#{bin}/auto-mobile --cli help 2>&1")
    assert_match(/Usage|help|tool/i, output)
  end
end

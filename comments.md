The first component to this comment is the document content which defines the extents of the comment and references the specific comment in the comments part:

```
<w:p>
  <w:r>
    <w:t xml:space="preserve">Some </w:t>
  </w:r>
  <w:commentRangeStart w:id="0" />
  <w:r>
    <w:t>text.</w:t>
  </w:r>
  <w:commentRangeEnd w:id="0" />
  <w:r>
    <w:commentReference w:id="0" />
  </w:r>
</w:p>
```
The `<commentRangeStart>` and `<commentRangeEnd>` elements (§2.13.4.4; §2.13.4.3) delimit the run content to which the comment with an `@id` of 0 applies (in this case, the single run of text). The following `<commentReference>` element (§2.13.4.5) links the preceding run content with a comment in the comments part with an `@id` of 0. Without all three of these elements, the range and comment cannot be linked (although the first two elements are optional, in which case the comment shall be anchored at the comment reference mark)

The second component to this comment is the comment content which defines the text in the comment:
```
<w:comment w:id="0" w:author="Joe Smith" w:date="2006-04-06T13:50:00Z" w:initials="User">
  <w:p>
    <w:pPr>
      <w:pStyle w:val="CommentText" />
    </w:pPr>
    <w:r>
      <w:rPr>
        <w:rStyle w:val="CommentReference" />
      </w:rPr>
      <w:annotationRef />
    </w:r>
    <w:r>
      <w:t>comment</w:t>
    </w:r>
  </w:p>
</w:comment>
```

In this example, the comment specifies that it was inserted by author Joe Smith with the initials User via the `@author` and `@date` attributes. It is linked to the run content via the `@id` attribute, which matches the value of 0 specified using the `<commentReference>` element above. The block-level content of the comment specifies that its text is comment and the style of the comment content is based off of the character style with the name CommentReference. ]